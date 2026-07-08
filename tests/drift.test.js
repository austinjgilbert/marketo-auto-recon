import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDrift, driftCheckDue } from '../src/drift.js';
import { harvestOnce } from '../src/harvester.js';
import { buildSignalMap } from '../src/signal-map.js';
import { runRecon } from '../src/recon.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';
import { INSTANCE, MOCK_NOW } from '../fixtures/instance.js';

const NOW = new Date(MOCK_NOW);

function clientFor(instance = INSTANCE) {
  return new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport: createMockTransport(instance) });
}

/** A copy of the fixture instance that grew after mapping. */
function grownInstance() {
  return {
    ...INSTANCE,
    activityTypes: [
      ...INSTANCE.activityTypes,
      // Heuristics classify this confidently (webinar → event_attended, 0.75).
      { id: 100010, name: 'Attended Partner Webinar', description: 'Custom webinar attendance from partner platform' },
      // Nothing matches this — must land as unmapped, loudly.
      { id: 100011, name: 'Quantum Flux Interaction', description: 'No keyword matches this' },
    ],
    forms: [
      ...INSTANCE.forms,
      { id: 9101, name: 'Talk to Sales - EMEA', status: 'approved' },
    ],
  };
}

test('driftCheckDue: first run, stale, and fresh checks', () => {
  assert.equal(driftCheckDue({ lastDriftCheckAt: null }, NOW), true, 'never checked');
  assert.equal(driftCheckDue({ lastDriftCheckAt: new Date(NOW - 25 * 3_600_000).toISOString() }, NOW), true, 'over a day');
  assert.equal(driftCheckDue({ lastDriftCheckAt: new Date(NOW - 2 * 3_600_000).toISOString() }, NOW), false, 'checked recently');
});

test('detectDrift returns null when the instance matches the map', async () => {
  const signalMap = await buildSignalMap(await runRecon(clientFor()));
  const record = await detectDrift(clientFor(), signalMap, { now: NOW });
  assert.equal(record, null);
});

test('detectDrift hot-adds confident types, flags the rest unmapped, never touches disk shape', async () => {
  const signalMap = await buildSignalMap(await runRecon(clientFor()));
  const logs = [];
  const record = await detectDrift(clientFor(grownInstance()), signalMap, { now: NOW, log: (m) => logs.push(m) });

  assert.equal(record.newActivityTypes.length, 2);
  const webinar = record.newActivityTypes.find((t) => t.id === 100010);
  assert.equal(webinar.hotAdded, true);
  assert.equal(webinar.canonical, 'event_attended');
  assert.equal(signalMap.activityTypes[100010].hotAdded, true, 'hot-added into the in-memory map');

  const quantum = record.newActivityTypes.find((t) => t.id === 100011);
  assert.equal(quantum.hotAdded, false);
  assert.ok(signalMap.unmapped.some((u) => u.id === 100011), 'unknown type lands in unmapped for human review');

  const form = record.newForms.find((f) => f.name === 'Talk to Sales - EMEA');
  assert.equal(form.hotAdded, true, 'contact form intent classified confidently');
  assert.equal(form.signalType, 'contact_us');

  assert.ok(logs.some((m) => m.includes('DRIFT: new activity type')), 'loud per-item log');
  assert.ok(logs.some((m) => m.includes('NOT changed')), 'explicitly says the disk map is untouched');
});

test('harvestOnce runs the drift check daily and persists the record', async () => {
  const signalMap = await buildSignalMap(await runRecon(clientFor()));
  const logs = [];
  const first = await harvestOnce(clientFor(grownInstance()), signalMap, {
    state: { sinceTokens: {}, emittedKeys: [], patternState: {}, eventCache: {} },
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
    log: (m) => logs.push(m),
  });
  assert.equal(first.state.lastDriftCheckAt, NOW.toISOString());
  assert.equal(first.state.drift.newActivityTypes.length, 2);
  assert.ok(logs.some((m) => m.includes('DRIFT SUMMARY')));

  // Second pass within the same day: no re-check, record persists.
  const second = await harvestOnce(clientFor(grownInstance()), signalMap, {
    state: first.state,
    sinks: [],
    now: new Date(NOW.getTime() + 15 * 60_000),
  });
  assert.equal(second.state.lastDriftCheckAt, NOW.toISOString(), 'not re-checked within a day');
  assert.equal(second.state.drift.newActivityTypes.length, 2, 'drift record persists');
});
