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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeActivities, buildLeadJourney, buildAccountJourney, domainOf } from './normalizer.js';
import { extractEventSignals, extractPatternSignals, nextPatternState } from './interpreter.js';

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

/** Atomic write (temp file + rename) so a crash mid-write never corrupts state. */
export function saveState(outputDir, state) {
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, '.state.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
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

/** Merge new normalized events into a domain's cache: dedupe by event id, prune to the lookback window, cap size. */
function mergeEventCache(cached, newEvents, { now, journeyLookbackDays }) {
  const cutoff = new Date(now.getTime() - journeyLookbackDays * 86_400_000).toISOString();
  const byId = new Map();
  for (const e of [...(cached || []), ...newEvents]) {
    if (e.ts >= cutoff) byId.set(e.id, e);
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
    (byDomain.get(domain) || byDomain.set(domain, []).get(domain)).push(lead);
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
          const history = await client.getLeadActivities(unseenLeadIds, {
            sinceDatetime: since,
            activityTypeIds: mappedTypeIds,
          });
          pulledEvents = normalizeActivities(history, signalMap);
          for (const id of unseenLeadIds) knownLeadIds.add(id);
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

  /* 6 — dedupe against everything ever emitted */
  const emitted = new Set(state.emittedKeys || []);
  const fresh = allSignals.filter((s) => !emitted.has(s.dedupeKey));
  for (const s of fresh) emitted.add(s.dedupeKey);

  /* 7 — fan out */
  const sinkResults = [];
  for (const sink of sinks) {
    try {
      const result = await sink.emit(fresh);
      sinkResults.push({ sink: sink.name, ...result });
      log(`sink ${sink.name}: ${JSON.stringify(result)}`);
    } catch (err) {
      sinkResults.push({ sink: sink.name, ok: false, error: err.message });
      log(`sink ${sink.name} failed: ${err.message}`);
    }
  }

  return {
    signals: fresh,
    emitted: fresh.length,
    sinkResults,
    apiCallsUsedToday: apiUsed(),
    state: {
      ...baseState(),
      emittedKeys: [...emitted].slice(-emittedKeysCap),
      patternState,
      eventCache,
    },
  };
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
