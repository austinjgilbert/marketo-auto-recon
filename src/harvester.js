/**
 * Stage: Harvest — the always-on half of the engine. Polls Marketo
 * incrementally (paging tokens persisted across runs), turns new activity
 * into state-change signals via the interpreter, dedupes against everything
 * already emitted, and fans out to the configured sinks. Restart-safe:
 * outputs/.state.json carries per-chunk since-tokens, emitted dedupe keys,
 * the per-account pattern state (known committee members, stalled leads),
 * a rolling per-account event cache (so pattern passes don't re-pull months
 * of history every poll), and a daily API-call budget counter.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeActivities, buildLeadJourney, buildAccountJourney, domainOf } from './normalizer.js';
import { extractEventSignals, extractPatternSignals, nextPatternState } from './interpreter.js';
import { detectDrift, driftCheckDue } from './drift.js';

const DEFAULT_EMITTED_KEYS_CAP = 50_000;
const EVENT_CACHE_MAX_EVENTS = 5_000; // per domain — most-recent kept
const DEFAULT_DAILY_API_BUDGET = 10_000;
const LOCK_STALE_MS = 15 * 60_000;
const LEAD_FIELDS = ['id', 'email', 'firstName', 'lastName', 'title', 'company', 'website', 'leadScore', 'leadStatus'];

/* ── state persistence ── */

const EMPTY_STATE = () => ({
  sinceTokens: {},
  emittedKeys: [],
  patternState: {},
  eventCache: {},
  apiBudget: null,
  lastRunAt: null,
  lastDriftCheckAt: null,
  drift: null,
});

export function loadState(outputDir) {
  const file = join(outputDir, '.state.json');
  if (!existsSync(file)) return EMPTY_STATE();
  try {
    return { ...EMPTY_STATE(), ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return EMPTY_STATE();
  }
}

/** Atomic write (temp file + rename) so a crash mid-write never corrupts state.
    Compact JSON: the event cache makes this file large on busy instances. */
export function saveState(outputDir, state) {
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, '.state.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), 'utf8');
  renameSync(tmp, file);
}

/* ── state lock — a cron `harvest --once` colliding with a running daemon
      would otherwise clobber .state.json (token rollback → duplicate signals,
      or token skip → lost signals) ── */

export function acquireLock(outputDir, { staleMs = LOCK_STALE_MS, now = Date.now() } = {}) {
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, '.state.lock');
  const tryWrite = () => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  };
  if (tryWrite()) return makeLock(file);
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* unreadable lock — treat as stale */
  }
  if (!holder || now - holder.at > staleMs) {
    try {
      unlinkSync(file);
    } catch {
      /* raced with the holder releasing — fall through to retry */
    }
    if (tryWrite()) return makeLock(file);
  }
  return null; // held by a live process
}

function makeLock(file) {
  return {
    file,
    refresh() {
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      } catch {
        /* best effort */
      }
    },
    release() {
      try {
        unlinkSync(file);
      } catch {
        /* already gone */
      }
    },
  };
}

/* ── helpers ── */

function typeChunks(mappedTypeIds) {
  const sorted = [...mappedTypeIds].sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < sorted.length; i += 10) chunks.push(sorted.slice(i, i + 10));
  return chunks;
}

const chunkKey = (chunk) => chunk.join(',');

function budgetFor(state, now) {
  const date = now.toISOString().slice(0, 10);
  const prior = state.apiBudget && state.apiBudget.date === date ? state.apiBudget.used : 0;
  return { date, prior };
}

/** Slim a normalized event for the cache: pattern signals, stalls, stages, and
    topics read only these fields — the raw `attrs` blob (needed only by
    extractEventSignals, which runs on fresh poll events) would bloat state. */
function slimEvent(e) {
  return {
    id: e.id,
    leadId: e.leadId,
    ts: e.ts,
    canonicalType: e.canonicalType,
    asset: e.asset,
    url: e.url,
    urlCategory: e.urlCategory,
    formIntent: e.formIntent,
    scoreDelta: e.scoreDelta,
  };
}

/** Merge new normalized events into a domain's cache: dedupe by event id, prune to the lookback window, cap size. */
function mergeEventCache(cached, newEvents, { now, journeyLookbackDays }) {
  const cutoff = new Date(now.getTime() - journeyLookbackDays * 86_400_000).toISOString();
  const byId = new Map();
  for (const e of [...(cached || []), ...newEvents]) {
    if (e.ts >= cutoff) byId.set(e.id, slimEvent(e));
  }
  const merged = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  return merged.length > EVENT_CACHE_MAX_EVENTS ? merged.slice(-EVENT_CACHE_MAX_EVENTS) : merged;
}

/**
 * One harvest pass. Pure-ish: all I/O goes through the injected client and
 * sinks; state in, new state out. `initialLookbackDays` bounds the very first
 * run so a fresh install doesn't flood sinks with months of history.
 */
export async function harvestOnce(
  client,
  signalMap,
  {
    state,
    sinks,
    now = new Date(),
    initialLookbackDays = 7,
    journeyLookbackDays = 90,
    dailyApiBudget = DEFAULT_DAILY_API_BUDGET,
    emittedKeysCap = DEFAULT_EMITTED_KEYS_CAP,
    log = () => {},
  },
) {
  const { date: budgetDate, prior: budgetPrior } = budgetFor(state, now);
  const callCountStart = client.callCount;
  const apiUsed = () => budgetPrior + (client.callCount - callCountStart);
  const overBudget = () => apiUsed() >= dailyApiBudget;

  /* 0 — drift check (once per day, 2 API calls): re-inventory activity types
     and forms so items created after `mse map` don't stay invisible forever.
     High-confidence classifications are hot-added to the in-memory map before
     the type chunks below are computed. */
  let lastDriftCheckAt = state.lastDriftCheckAt || null;
  let drift = state.drift || null;
  if (driftCheckDue(state, now)) {
    try {
      const record = await detectDrift(client, signalMap, { now, log });
      lastDriftCheckAt = now.toISOString();
      if (record) drift = record;
    } catch (err) {
      log(`drift check failed (will retry next pass): ${err.message}`);
    }
  }

  /* 1 — per-chunk since-tokens. Each 10-type chunk advances through the
     activity stream at its own rate; persisting a single shared token loses
     or double-pulls activity whenever >10 types are mapped. */
  const mappedTypeIds = Object.keys(signalMap.activityTypes)
    .map(Number)
    .filter((id) => signalMap.activityTypes[id].canonical !== 'ignore');
  const chunks = typeChunks(mappedTypeIds);
  const sinceTokens = { ...(state.sinceTokens || {}) };

  let seedToken = null;
  for (const chunk of chunks) {
    const key = chunkKey(chunk);
    if (sinceTokens[key]) continue;
    if (state.sinceToken) {
      // Legacy single-token state — seed every chunk from it.
      sinceTokens[key] = state.sinceToken;
      continue;
    }
    if (!seedToken) {
      const since = new Date(now.getTime() - initialLookbackDays * 86_400_000).toISOString();
      seedToken = await client.getPagingToken(since);
      log(`first run — starting from ${since}`);
    }
    sinceTokens[key] = seedToken;
  }

  /* 2 — pull new activities per chunk, advancing each token independently */
  const newActivities = [];
  for (const chunk of chunks) {
    const key = chunkKey(chunk);
    for await (const page of client.iterateActivities({ nextPageToken: sinceTokens[key], activityTypeIds: chunk })) {
      newActivities.push(...page.activities);
      if (page.nextPageToken) sinceTokens[key] = page.nextPageToken;
    }
  }
  log(`${newActivities.length} new activities since last poll`);

  const baseState = () => ({
    ...state,
    sinceToken: null, // legacy field, migrated into sinceTokens
    sinceTokens,
    apiBudget: { date: budgetDate, used: apiUsed() },
    lastRunAt: now.toISOString(),
    lastDriftCheckAt,
    drift,
  });

  if (!newActivities.length) {
    return { signals: [], emitted: 0, state: baseState(), sinkResults: [], apiCallsUsedToday: apiUsed() };
  }

  /* 3 — resolve the leads involved */
  const leadIds = [...new Set(newActivities.map((a) => a.leadId))];
  const leads = [];
  for (let i = 0; i < leadIds.length; i += 100) {
    leads.push(...(await client.getLeadsByFilter('id', leadIds.slice(i, i + 100), LEAD_FIELDS)));
  }

  /* 4 — group by account domain */
  const byDomain = new Map();
  for (const lead of leads) {
    const domain = domainOf(lead);
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(lead);
  }

  /* 5 — signals per active account */
  const allSignals = [];
  const patternState = { ...(state.patternState || {}) };
  const eventCache = { ...(state.eventCache || {}) };
  for (const [domain, domainLeads] of byDomain) {
    const domainLeadIds = new Set(domainLeads.map((l) => l.id));
    const domainNew = normalizeActivities(
      newActivities.filter((a) => domainLeadIds.has(a.leadId)),
      signalMap,
    );

    /* event-driven signals from just the new activity */
    const leadInfoById = new Map(
      domainLeads.map((l) => [l.id, { email: l.email, name: [l.firstName, l.lastName].filter(Boolean).join(' '), title: l.title }]),
    );
    allSignals.push(...extractEventSignals(domainNew, { domain, leadById: leadInfoById, signalMap }));

    /* pattern signals need the fuller journey for this account. The rolling
       event cache means history is pulled from the API only for leads we
       have never seen — every later poll appends this poll's own activity. */
    try {
      const cached = eventCache[domain];
      const knownLeadIds = new Set(cached?.leadIds || []);
      const unseenLeadIds = [...domainLeadIds].filter((id) => !knownLeadIds.has(id));

      let pulledEvents = [];
      if (unseenLeadIds.length) {
        if (overBudget()) {
          log(
            `DAILY API BUDGET EXHAUSTED (${apiUsed()}/${dailyApiBudget}) — skipping history pull for ${domain}; ` +
              `event signals still flow. Raise MSE_DAILY_API_BUDGET if this is expected volume.`,
          );
        } else {
          const since = new Date(now.getTime() - journeyLookbackDays * 86_400_000).toISOString();
          // Only leads whose chunk fully completed are marked known — if the
          // budget trips mid-pull, the rest are retried under tomorrow's budget.
          const completedLeadIds = [];
          const history = await client.getLeadActivities(unseenLeadIds, {
            sinceDatetime: since,
            activityTypeIds: mappedTypeIds,
            shouldStop: overBudget,
            onLeadChunkDone: (ids) => completedLeadIds.push(...ids),
          });
          const completedSet = new Set(completedLeadIds);
          pulledEvents = normalizeActivities(
            history.filter((a) => completedSet.has(a.leadId)),
            signalMap,
          );
          for (const id of completedLeadIds) knownLeadIds.add(id);
          if (completedLeadIds.length < unseenLeadIds.length) {
            log(
              `DAILY API BUDGET EXHAUSTED mid-pull for ${domain} — history fetched for ` +
                `${completedLeadIds.length}/${unseenLeadIds.length} new lead(s); the rest retry tomorrow.`,
            );
          }
        }
      }

      const events = mergeEventCache(cached?.events, [...pulledEvents, ...domainNew], { now, journeyLookbackDays });
      eventCache[domain] = { leadIds: [...knownLeadIds], events };

      const journeys = domainLeads.map((l) => buildLeadJourney(l, events));
      const accountJourney = buildAccountJourney(journeys);
      allSignals.push(
        ...extractPatternSignals(accountJourney, { signalMap, now, state: patternState[domain] || {} }),
      );
      patternState[domain] = nextPatternState(accountJourney, { signalMap, now });
    } catch (err) {
      log(`pattern pass failed for ${domain} (event signals still emitted): ${err.message}`);
    }
  }

  /* evict accounts that aged out of the journey window entirely, so eventCache
     and patternState don't grow without bound across a long-lived daemon */
  const evictCutoff = new Date(now.getTime() - journeyLookbackDays * 86_400_000).toISOString();
  for (const [domain, entry] of Object.entries(eventCache)) {
    const lastTs = entry.events?.[entry.events.length - 1]?.ts;
    if (!lastTs || lastTs < evictCutoff) {
      delete eventCache[domain];
      delete patternState[domain];
    }
  }

  /* 6 — dedupe against everything ever emitted */
  const emitted = new Set(state.emittedKeys || []);
  const fresh = allSignals.filter((s) => !emitted.has(s.dedupeKey));
  for (const s of fresh) emitted.add(s.dedupeKey);

  /* 7 — fan out. Failures are captured per sink so the caller can dead-letter
     them: dedupe keys were already recorded, so without a replay path a sink
     outage would lose those signals forever. The jsonl sink is the local
     durable record and is not dead-lettered. */
  const sinkResults = [];
  const failedDeliveries = [];
  for (const sink of sinks) {
    let result;
    try {
      result = await sink.emit(fresh);
      sinkResults.push({ sink: sink.name, ...result });
      log(`sink ${sink.name}: ${JSON.stringify(result)}`);
    } catch (err) {
      result = { ok: false, error: err.message };
      sinkResults.push({ sink: sink.name, ...result });
      log(`sink ${sink.name} failed: ${err.message}`);
    }
    if (!result.ok && sink.name !== 'jsonl' && fresh.length) {
      failedDeliveries.push({ sink: sink.name, error: result.error || `status ${result.status}`, signals: fresh });
    }
  }

  return {
    signals: fresh,
    emitted: fresh.length,
    sinkResults,
    failedDeliveries,
    apiCallsUsedToday: apiUsed(),
    state: {
      ...baseState(),
      emittedKeys: [...emitted].slice(-emittedKeysCap),
      patternState,
      eventCache,
    },
  };
}

/* ── dead-letter file: signals whose sink delivery failed ──
   One JSON row per (sink, signal). `mse harvest --replay-failed` re-emits. */

export function appendFailedDeliveries(outputDir, failedDeliveries) {
  if (!failedDeliveries?.length) return 0;
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, 'signals-failed.jsonl');
  const rows = failedDeliveries.flatMap(({ sink, error, signals }) =>
    signals.map((signal) => JSON.stringify({ sink, error, failedAt: new Date().toISOString(), signal })),
  );
  appendFileSync(file, rows.join('\n') + '\n', 'utf8');
  return rows.length;
}

export function loadFailedDeliveries(outputDir) {
  const file = join(outputDir, 'signals-failed.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Re-emit dead-lettered signals to their (now hopefully healthy) sinks.
 * Rows whose replay succeeds are dropped; still-failing rows (and rows whose
 * sink is no longer configured) are kept for the next attempt.
 */
export async function replayFailedDeliveries(outputDir, sinks, { log = () => {} } = {}) {
  const rows = loadFailedDeliveries(outputDir);
  if (!rows.length) {
    log('no failed deliveries to replay');
    return { replayed: 0, remaining: 0 };
  }
  const sinkByName = new Map(sinks.map((s) => [s.name, s]));
  const remaining = [];
  let replayed = 0;

  const bySink = new Map();
  for (const row of rows) {
    if (!bySink.has(row.sink)) bySink.set(row.sink, []);
    bySink.get(row.sink).push(row);
  }

  for (const [sinkName, sinkRows] of bySink) {
    const sink = sinkByName.get(sinkName);
    if (!sink) {
      log(`sink ${sinkName} is not configured — keeping ${sinkRows.length} row(s) in the dead-letter file`);
      remaining.push(...sinkRows);
      continue;
    }
    let result;
    try {
      result = await sink.emit(sinkRows.map((r) => r.signal));
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result.ok) {
      replayed += sinkRows.length;
      log(`sink ${sinkName}: replayed ${sinkRows.length} signal(s)`);
    } else {
      remaining.push(...sinkRows);
      log(`sink ${sinkName}: replay failed (${result.error || `status ${result.status}`}) — keeping ${sinkRows.length} row(s)`);
    }
  }

  const file = join(outputDir, 'signals-failed.jsonl');
  if (remaining.length) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, remaining.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    renameSync(tmp, file);
  } else if (existsSync(file)) {
    unlinkSync(file);
  }
  return { replayed, remaining: remaining.length };
}

/** Daemon loop around harvestOnce with persisted state and a held lock. */
export async function harvestDaemon(
  client,
  signalMap,
  { outputDir, sinks, intervalMs, nowFn = () => new Date(), harvestOptions = {}, log = console.error },
) {
  const lock = acquireLock(outputDir);
  if (!lock) {
    log(`another harvest is already running against ${outputDir} (outputs/.state.lock) — exiting.`);
    process.exitCode = 1;
    return;
  }
  log(`harvest daemon: polling every ${Math.round(intervalMs / 1000)}s (ctrl-c to stop)`);
  try {
    for (;;) {
      lock.refresh();
      const state = loadState(outputDir);
      try {
        const result = await harvestOnce(client, signalMap, { state, sinks, now: nowFn(), log, ...harvestOptions });
        saveState(outputDir, result.state);
        const deadLettered = appendFailedDeliveries(outputDir, result.failedDeliveries);
        if (deadLettered) log(`${deadLettered} signal(s) dead-lettered to signals-failed.jsonl — run \`mse harvest --replay-failed\` once the sink recovers`);
        log(`${new Date().toISOString()} — emitted ${result.emitted} signal(s); API calls today: ${result.apiCallsUsedToday}`);
      } catch (err) {
        log(`harvest pass failed (state unchanged, will retry): ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    lock.release();
  }
}
