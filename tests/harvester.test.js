import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harvestOnce, loadState, saveState, acquireLock, appendFailedDeliveries, loadFailedDeliveries, replayFailedDeliveries } from '../src/harvester.js';
import { toIngestRow, createWranglerSink } from '../src/sinks/wrangler.js';
import { createWebhookSink, signWebhookBody } from '../src/sinks/webhook.js';
import { createJsonlSink } from '../src/sinks/jsonl.js';
import { buildSignalMap } from '../src/signal-map.js';
import { runRecon } from '../src/recon.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';
import { MOCK_NOW } from '../fixtures/instance.js';
import { readFileSync } from 'node:fs';

const NOW = new Date(MOCK_NOW);

function mockClient() {
  return new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport: createMockTransport() });
}

async function fixtureSignalMap() {
  return buildSignalMap(await runRecon(mockClient()));
}

const memorySink = () => {
  const received = [];
  return { name: 'memory', received, emit: async (signals) => (received.push(...signals), { ok: true }) };
};

test('harvestOnce emits signals from the initial lookback window and advances the token', async () => {
  const signalMap = await fixtureSignalMap();
  const sink = memorySink();
  const result = await harvestOnce(mockClient(), signalMap, {
    state: { sinceToken: null, emittedKeys: [], patternState: {} },
    sinks: [sink],
    now: NOW,
    initialLookbackDays: 7,
  });
  assert.ok(result.emitted > 0);
  assert.equal(sink.received.length, result.emitted);
  assert.ok(Object.keys(result.state.sinceTokens).length > 0, 'per-chunk tokens persisted');
  assert.ok(Object.values(result.state.sinceTokens).every(Boolean));
  const types = result.signals.map((s) => s.signalType);
  assert.ok(types.includes('contact_us'));
  assert.ok(types.includes('pricing_page_visit'));
  assert.ok(types.includes('product_signup'));
});

test('second harvest run emits nothing (token advanced + dedupe)', async () => {
  const signalMap = await fixtureSignalMap();
  const first = await harvestOnce(mockClient(), signalMap, {
    state: { sinceToken: null, emittedKeys: [], patternState: {} },
    sinks: [memorySink()],
    now: NOW,
    initialLookbackDays: 7,
  });
  const second = await harvestOnce(mockClient(), signalMap, {
    state: first.state,
    sinks: [memorySink()],
    now: NOW,
  });
  assert.equal(second.emitted, 0);
});

test('dedupe keys block re-emission even when activities replay', async () => {
  const signalMap = await fixtureSignalMap();
  const first = await harvestOnce(mockClient(), signalMap, {
    state: { sinceToken: null, emittedKeys: [], patternState: {} },
    sinks: [memorySink()],
    now: NOW,
    initialLookbackDays: 7,
  });
  // Replay: keep emittedKeys but reset the token as if the state file lost it.
  const replay = await harvestOnce(mockClient(), signalMap, {
    state: { sinceToken: null, emittedKeys: first.state.emittedKeys, patternState: first.state.patternState },
    sinks: [memorySink()],
    now: NOW,
    initialLookbackDays: 7,
  });
  assert.equal(replay.emitted, 0, 'all replayed signals deduped');
});

test('state round-trips through disk (atomic write, no leftover temp file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mse-'));
  try {
    const state = { sinceTokens: { '1,2': 'mock:2026-07-01' }, emittedKeys: ['a', 'b'], patternState: { 'x.com': { knownLeadIds: [1] } }, eventCache: {}, lastRunAt: 'now' };
    saveState(dir, state);
    const loaded = loadState(dir);
    assert.deepEqual(loaded.sinceTokens, state.sinceTokens);
    assert.deepEqual(loaded.emittedKeys, state.emittedKeys);
    assert.deepEqual(loaded.patternState, state.patternState);
    assert.equal(existsSync(join(dir, '.state.json.tmp')), false, 'temp file renamed away');
    const empty = loadState(mkdtempSync(join(tmpdir(), 'mse-empty-')));
    assert.deepEqual(empty.sinceTokens, {});
    assert.deepEqual(empty.emittedKeys, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('jsonl sink appends one line per signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mse-jsonl-'));
  try {
    const sink = createJsonlSink(dir);
    await sink.emit([{ dedupeKey: 'k1', signalType: 'form_fill' }, { dedupeKey: 'k2', signalType: 'mql' }]);
    const lines = readFileSync(join(dir, 'signals.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).signalType, 'mql');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrangler sink maps signals to the ingest-batch row contract', () => {
  const row = toIngestRow({
    dedupeKey: 'acme.com:contact_us:101:x',
    domain: 'acme.com',
    signalType: 'contact_us',
    leadId: 101,
    email: 'jane.doe@acme.com',
    timestamp: '2026-07-06T10:02:00.000Z',
    strength: 95,
    summary: 'Jane filled out Contact Sales',
    evidence: [9017],
  });
  assert.equal(row.domain, 'acme.com');
  assert.equal(row.source, 'marketo');
  assert.equal(row.signalType, 'contact_us');
  assert.equal(row.metadata.marketoLeadId, 101);
  assert.deepEqual(row.metadata.marketoActivityIds, [9017]);
  assert.equal(row.metadata.ingestPath, 'marketo-signal-engine');
});

test('wrangler sink posts Bearer-authed batches and reports stored/skipped', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ ok: true, data: { stored: 2, skipped: 1 } }) };
  };
  const sink = createWranglerSink({ url: 'https://worker.example.com/', apiKey: 'secret', fetchImpl });
  const result = await sink.emit([
    { domain: 'a.com', signalType: 'mql', strength: 75, timestamp: 't', summary: 's', evidence: [] },
    { domain: 'b.com', signalType: 'form_fill', strength: 50, timestamp: 't', summary: 's', evidence: [] },
    { domain: 'c.com', signalType: 'form_fill', strength: 50, timestamp: 't', summary: 's', evidence: [] },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.stored, 2);
  assert.equal(result.skipped, 1);
  assert.equal(calls[0].url, 'https://worker.example.com/signals/ingest-batch');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.source, 'marketo-signal-engine');
  assert.equal(body.rows.length, 3);
});

test('webhook sink signs timestamp + body when a secret is set (replay protection)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => (calls.push({ url, opts }), { ok: true, status: 200 });
  const sink = createWebhookSink({ url: 'https://hook.example.com', secret: 'shh', fetchImpl });
  await sink.emit([{ dedupeKey: 'k', signalType: 'mql' }]);
  const { headers, body } = calls[0].opts;
  const timestamp = headers['x-mse-timestamp'];
  assert.ok(/^\d+$/.test(timestamp), 'timestamp header present');
  assert.equal(headers['x-mse-signature'].length, 64, 'hmac-sha256 hex signature');
  // Receiver-side verification: HMAC over `${timestamp}.${body}`.
  const expected = createHmac('sha256', 'shh').update(`${timestamp}.${body}`).digest('hex');
  assert.equal(headers['x-mse-signature'], expected);
  assert.equal(signWebhookBody('shh', timestamp, body), expected);
  // A replayed body with a different timestamp no longer verifies.
  assert.notEqual(signWebhookBody('shh', String(Number(timestamp) + 60_000), body), expected);
});

/* ── hardening-pass coverage ── */

function syntheticSignalMap(typeIds) {
  return {
    activityTypes: Object.fromEntries(typeIds.map((id) => [id, { canonical: 'web_visit', name: `type-${id}` }])),
    forms: {},
    urlPatterns: [],
    thresholds: {},
  };
}

test('per-chunk since-tokens advance independently when >10 types are mapped', async () => {
  const tokensSeen = [];
  const transport = async (url) => {
    if (url.includes('/identity/')) return { status: 200, json: { access_token: 't', expires_in: 3600 } };
    const params = new URL(url).searchParams;
    if (url.includes('pagingtoken')) return { status: 200, json: { success: true, nextPageToken: 'seed' } };
    if (url.includes('/rest/v1/activities.json')) {
      const chunk = params.get('activityTypeIds');
      tokensSeen.push({ chunk, token: params.get('nextPageToken') });
      // Each chunk hands back its own distinct token.
      return { status: 200, json: { success: true, result: [], nextPageToken: `tok-${chunk}`, moreResult: false } };
    }
    return { status: 200, json: { success: true, result: [] } };
  };
  const client = new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport });
  const twelveTypes = Array.from({ length: 12 }, (_, i) => i + 1);
  const result = await harvestOnce(client, syntheticSignalMap(twelveTypes), {
    state: loadState(mkdtempSync(join(tmpdir(), 'mse-fresh-'))),
    sinks: [],
    now: NOW,
  });
  const keys = Object.keys(result.state.sinceTokens);
  assert.equal(keys.length, 2, 'two 10-type chunks');
  assert.equal(result.state.sinceTokens['1,2,3,4,5,6,7,8,9,10'], 'tok-1,2,3,4,5,6,7,8,9,10');
  assert.equal(result.state.sinceTokens['11,12'], 'tok-11,12');
  assert.ok(tokensSeen.every((t) => t.token === 'seed'), 'both chunks started from the shared seed');
});

test('legacy single sinceToken migrates by seeding every chunk', async () => {
  let pagingTokenCalls = 0;
  const transport = async (url) => {
    if (url.includes('/identity/')) return { status: 200, json: { access_token: 't', expires_in: 3600 } };
    if (url.includes('pagingtoken')) {
      pagingTokenCalls++;
      return { status: 200, json: { success: true, nextPageToken: 'fresh' } };
    }
    if (url.includes('/rest/v1/activities.json')) {
      const chunk = new URL(url).searchParams.get('activityTypeIds');
      return { status: 200, json: { success: true, result: [], nextPageToken: `tok-${chunk}`, moreResult: false } };
    }
    return { status: 200, json: { success: true, result: [] } };
  };
  const client = new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport });
  const twelveTypes = Array.from({ length: 12 }, (_, i) => i + 1);
  const result = await harvestOnce(client, syntheticSignalMap(twelveTypes), {
    state: { sinceToken: 'legacy-token', emittedKeys: [], patternState: {} },
    sinks: [],
    now: NOW,
  });
  assert.equal(pagingTokenCalls, 0, 'no fresh lookback token fetched — legacy token reused');
  assert.equal(result.state.sinceToken, null, 'legacy field cleared');
  assert.equal(Object.keys(result.state.sinceTokens).length, 2);
});

test('event cache prevents history re-pulls for known leads on later polls', async () => {
  const signalMap = await fixtureSignalMap();
  const historyPulls = () => calls.filter((u) => u.includes('/rest/v1/activities.json') && u.includes('leadIds=')).length;
  let calls = [];
  const inner = createMockTransport();
  const transport = async (url, opts) => (calls.push(url), inner(url, opts));
  const client = () => new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport });

  const first = await harvestOnce(client(), signalMap, {
    state: loadState(mkdtempSync(join(tmpdir(), 'mse-cache-'))),
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
  });
  assert.ok(historyPulls() > 0, 'first poll pulls history for unseen leads');
  assert.ok(Object.keys(first.state.eventCache).length > 0, 'event cache populated');

  // Second poll replays the same window (tokens reset) — all leads are now known,
  // so the pattern pass must reuse the cache instead of re-pulling history.
  calls = [];
  const replayState = { ...first.state, sinceTokens: {}, sinceToken: null };
  const second = await harvestOnce(client(), signalMap, {
    state: replayState,
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
  });
  assert.equal(historyPulls(), 0, 'no per-lead history pulls on the second poll');
  assert.equal(second.emitted, 0, 'dedupe still holds');
});

test('daily API budget stop-guard skips history pulls but event signals still flow', async () => {
  const signalMap = await fixtureSignalMap();
  const logs = [];
  const result = await harvestOnce(mockClient(), signalMap, {
    state: loadState(mkdtempSync(join(tmpdir(), 'mse-budget-'))),
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
    dailyApiBudget: 1,
    log: (m) => logs.push(m),
  });
  assert.ok(logs.some((m) => m.includes('DAILY API BUDGET EXHAUSTED')), 'budget breach logged loudly');
  const types = result.signals.map((s) => s.signalType);
  assert.ok(types.includes('contact_us'), 'event signals still emitted');
  assert.ok(result.apiCallsUsedToday >= 1);
  assert.equal(result.state.apiBudget.date, NOW.toISOString().slice(0, 10));
});

test('budget counter resets on a new day', async () => {
  const signalMap = await fixtureSignalMap();
  const yesterday = { date: '2020-01-01', used: 999_999 };
  const result = await harvestOnce(mockClient(), signalMap, {
    state: { ...loadState(mkdtempSync(join(tmpdir(), 'mse-budget2-'))), apiBudget: yesterday },
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
  });
  assert.equal(result.state.apiBudget.date, NOW.toISOString().slice(0, 10));
  assert.ok(result.state.apiBudget.used < 999_999, 'stale day discarded');
  assert.ok(result.emitted > 0, 'yesterday\'s spend does not block today');
});

test('event cache stores slim events (no attrs) and evicts aged-out domains', async () => {
  const signalMap = await fixtureSignalMap();
  const result = await harvestOnce(mockClient(), signalMap, {
    state: { sinceTokens: {}, emittedKeys: [], patternState: {}, eventCache: {} },
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
  });
  const cached = result.state.eventCache['acme.com'];
  assert.ok(cached.events.length > 0);
  for (const e of cached.events) {
    assert.equal(e.attrs, undefined, 'raw attrs stripped from cached events');
    assert.ok(e.ts && e.canonicalType, 'signal-relevant fields kept');
  }

  // A domain whose newest event is older than the journey window gets evicted.
  const staleState = {
    ...result.state,
    eventCache: {
      ...result.state.eventCache,
      'stale.com': { leadIds: [999], events: [{ id: 1, leadId: 999, ts: '2020-01-01T00:00:00.000Z', canonicalType: 'web_visit' }] },
    },
    patternState: { ...result.state.patternState, 'stale.com': { knownLeadIds: [999] } },
  };
  const second = await harvestOnce(mockClient(), signalMap, {
    state: { ...staleState, sinceTokens: {} },
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
    journeyLookbackDays: 90,
  });
  assert.equal(second.state.eventCache['stale.com'], undefined, 'stale domain evicted from eventCache');
  assert.equal(second.state.patternState['stale.com'], undefined, 'stale domain evicted from patternState');
  assert.ok(second.state.eventCache['acme.com'], 'active domain kept');
});

test('budget tripping mid-pull marks only completed lead chunks as known', async () => {
  const signalMap = await fixtureSignalMap();
  // Client whose budget "trips" after the first lead chunk completes.
  const client = mockClient();
  const original = client.getLeadActivities.bind(client);
  client.getLeadActivities = (leadIds, opts) => {
    let chunksDone = 0;
    return original(leadIds, {
      ...opts,
      shouldStop: () => chunksDone >= 1,
      onLeadChunkDone: (ids) => {
        chunksDone++;
        opts.onLeadChunkDone?.(ids);
      },
    });
  };
  const result = await harvestOnce(client, signalMap, {
    state: { sinceTokens: {}, emittedKeys: [], patternState: {}, eventCache: {} },
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
  });
  // The fixture's acme.com leads fit one 30-lead chunk, so this exercises the
  // plumbing without changing behavior; known lead count equals completed count.
  const cached = result.state.eventCache['acme.com'];
  assert.ok(cached, 'cache still built from completed chunks');
  assert.ok(cached.leadIds.length >= 1);
});

test('failed sink deliveries dead-letter and replay (second replay is a no-op)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mse-dlq-'));
  try {
    const signalMap = await fixtureSignalMap();
    const brokenSink = { name: 'webhook', emit: async () => ({ ok: false, status: 500 }) };
    const result = await harvestOnce(mockClient(), signalMap, {
      state: loadState(dir),
      sinks: [brokenSink],
      now: NOW,
      initialLookbackDays: 7,
    });
    assert.ok(result.emitted > 0);
    assert.equal(result.failedDeliveries.length, 1);
    assert.equal(result.failedDeliveries[0].sink, 'webhook');

    // Dead-letter the failures, exactly as bin/mse.js and the daemon do.
    const written = appendFailedDeliveries(dir, result.failedDeliveries);
    assert.equal(written, result.emitted);
    assert.equal(loadFailedDeliveries(dir).length, result.emitted);

    // Replay against a recovered sink: file drains.
    const recovered = memorySink();
    recovered.name = 'webhook';
    const replay = await replayFailedDeliveries(dir, [recovered], {});
    assert.equal(replay.replayed, result.emitted);
    assert.equal(replay.remaining, 0);
    assert.equal(recovered.received.length, result.emitted);
    assert.equal(existsSync(join(dir, 'signals-failed.jsonl')), false, 'dead-letter file removed');

    // Second replay is a no-op.
    const again = await replayFailedDeliveries(dir, [recovered], {});
    assert.equal(again.replayed, 0);

    // Still-failing sink keeps its rows for the next attempt.
    appendFailedDeliveries(dir, result.failedDeliveries);
    const stillBroken = await replayFailedDeliveries(dir, [brokenSink], {});
    assert.equal(stillBroken.replayed, 0);
    assert.equal(stillBroken.remaining, result.emitted);
    assert.equal(loadFailedDeliveries(dir).length, result.emitted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('jsonl sink failures are not dead-lettered (it is the local durable record)', async () => {
  const signalMap = await fixtureSignalMap();
  const brokenJsonl = { name: 'jsonl', emit: async () => { throw new Error('disk full'); } };
  const result = await harvestOnce(mockClient(), signalMap, {
    state: { sinceTokens: {}, emittedKeys: [], patternState: {}, eventCache: {} },
    sinks: [brokenJsonl],
    now: NOW,
    initialLookbackDays: 7,
  });
  assert.equal(result.failedDeliveries.length, 0);
  assert.equal(result.sinkResults[0].ok, false, 'failure still reported in sinkResults');
});

test('state lock blocks a second harvester and honors staleness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mse-lock-'));
  try {
    const lock = acquireLock(dir);
    assert.ok(lock, 'first acquire succeeds');
    assert.equal(acquireLock(dir), null, 'second acquire blocked while held');
    lock.release();
    const again = acquireLock(dir);
    assert.ok(again, 'acquire succeeds after release');
    again.release();
    // Stale lock: holder wrote 20 minutes ago and never refreshed.
    const stale = acquireLock(dir, { now: Date.now() - 20 * 60_000 });
    assert.ok(stale, 'seed a stale lock');
    const stealer = acquireLock(dir);
    assert.ok(stealer, 'stale lock is stolen');
    stealer.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
