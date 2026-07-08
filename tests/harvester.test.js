import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harvestOnce, loadState, saveState } from '../src/harvester.js';
import { toIngestRow, createWranglerSink } from '../src/sinks/wrangler.js';
import { createWebhookSink } from '../src/sinks/webhook.js';
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
  assert.ok(result.state.sinceToken, 'token persisted');
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

test('state round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mse-'));
  try {
    const state = { sinceToken: 'mock:2026-07-01', emittedKeys: ['a', 'b'], patternState: { 'x.com': { knownLeadIds: [1] } }, lastRunAt: 'now' };
    saveState(dir, state);
    assert.deepEqual(loadState(dir), state);
    assert.equal(loadState(mkdtempSync(join(tmpdir(), 'mse-empty-'))).sinceToken, null);
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

test('webhook sink signs the body when a secret is set', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => (calls.push({ url, opts }), { ok: true, status: 200 });
  const sink = createWebhookSink({ url: 'https://hook.example.com', secret: 'shh', fetchImpl });
  await sink.emit([{ dedupeKey: 'k', signalType: 'mql' }]);
  assert.ok(calls[0].opts.headers['x-mse-signature']?.length === 64, 'hmac-sha256 hex signature');
});
