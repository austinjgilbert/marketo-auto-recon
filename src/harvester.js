/**
 * Stage: Harvest — the always-on half of the engine. Polls Marketo
 * incrementally (paging tokens persisted across runs), turns new activity
 * into state-change signals via the interpreter, dedupes against everything
 * already emitted, and fans out to the configured sinks. Restart-safe:
 * outputs/.state.json carries the since-token, emitted dedupe keys, and the
 * per-account pattern state (known committee members, stalled leads).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeActivities, buildLeadJourney, buildAccountJourney, domainOf } from './normalizer.js';
import { extractEventSignals, extractPatternSignals, nextPatternState } from './interpreter.js';

const EMITTED_KEYS_CAP = 20_000;
const LEAD_FIELDS = ['id', 'email', 'firstName', 'lastName', 'title', 'company', 'website', 'leadScore', 'leadStatus'];

export function loadState(outputDir) {
  const file = join(outputDir, '.state.json');
  if (!existsSync(file)) {
    return { sinceToken: null, emittedKeys: [], patternState: {}, lastRunAt: null };
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { sinceToken: null, emittedKeys: [], patternState: {}, lastRunAt: null };
  }
}

export function saveState(outputDir, state) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, '.state.json'), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * One harvest pass. Pure-ish: all I/O goes through the injected client and
 * sinks; state in, new state out. `initialLookbackDays` bounds the very first
 * run so a fresh install doesn't flood sinks with months of history.
 */
export async function harvestOnce(client, signalMap, { state, sinks, now = new Date(), initialLookbackDays = 7, journeyLookbackDays = 90, log = () => {} }) {
  /* 1 — since-token */
  let token = state.sinceToken;
  if (!token) {
    const since = new Date(now.getTime() - initialLookbackDays * 86_400_000).toISOString();
    token = await client.getPagingToken(since);
    log(`first run — starting from ${since}`);
  }

  /* 2 — pull new activities for all mapped activity types */
  const mappedTypeIds = Object.keys(signalMap.activityTypes)
    .map(Number)
    .filter((id) => signalMap.activityTypes[id].canonical !== 'ignore');
  const newActivities = [];
  let nextToken = token;
  for (let i = 0; i < mappedTypeIds.length; i += 10) {
    const chunk = mappedTypeIds.slice(i, i + 10);
    for await (const page of client.iterateActivities({ nextPageToken: token, activityTypeIds: chunk })) {
      newActivities.push(...page.activities);
      if (page.nextPageToken) nextToken = page.nextPageToken;
    }
  }
  log(`${newActivities.length} new activities since last poll`);

  if (!newActivities.length) {
    return { signals: [], emitted: 0, state: { ...state, sinceToken: nextToken, lastRunAt: now.toISOString() }, sinkResults: [] };
  }

  /* 3 — resolve the leads involved */
  const leadIds = [...new Set(newActivities.map((a) => a.leadId))];
  const leads = [];
  for (let i = 0; i < leadIds.length; i += 100) {
    leads.push(...(await client.getLeadsByFilter('id', leadIds.slice(i, i + 100), LEAD_FIELDS)));
  }
  const leadById = new Map(leads.map((l) => [l.id, l]));

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

    /* pattern signals need the fuller journey for this account */
    try {
      const since = new Date(now.getTime() - journeyLookbackDays * 86_400_000).toISOString();
      const history = await client.getLeadActivities([...domainLeadIds], {
        sinceDatetime: since,
        activityTypeIds: mappedTypeIds,
      });
      const events = normalizeActivities(history, signalMap);
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
    state: {
      sinceToken: nextToken,
      emittedKeys: [...emitted].slice(-EMITTED_KEYS_CAP),
      patternState,
      lastRunAt: now.toISOString(),
    },
  };
}

/** Daemon loop around harvestOnce with persisted state. */
export async function harvestDaemon(client, signalMap, { outputDir, sinks, intervalMs, log = console.error }) {
  log(`harvest daemon: polling every ${Math.round(intervalMs / 1000)}s (ctrl-c to stop)`);
  for (;;) {
    const state = loadState(outputDir);
    try {
      const result = await harvestOnce(client, signalMap, { state, sinks, log });
      saveState(outputDir, result.state);
      log(`${new Date().toISOString()} — emitted ${result.emitted} signal(s)`);
    } catch (err) {
      log(`harvest pass failed (state unchanged, will retry): ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
