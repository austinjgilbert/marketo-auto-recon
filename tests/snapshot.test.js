import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/snapshot.js';
import { runSnapshotPipeline } from '../src/pipeline.js';
import { harvestOnce } from '../src/harvester.js';
import { interpretJourney } from '../src/interpreter.js';
import { normalizeActivities, buildLeadJourney, buildAccountJourney } from '../src/normalizer.js';
import { buildSignalMap } from '../src/signal-map.js';
import { runRecon } from '../src/recon.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';
import { ACTIVITIES, LEADS, MOCK_NOW } from '../fixtures/instance.js';

const NOW = new Date(MOCK_NOW);

function mockClient() {
  return new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport: createMockTransport() });
}

async function fixtureSnapshot(email = 'jane.doe@acme.com') {
  const signalMap = await buildSignalMap(await runRecon(mockClient()));
  const events = normalizeActivities(ACTIVITIES, signalMap);
  const acmeLeads = LEADS.filter((l) => l.email.endsWith('@acme.com'));
  const journeys = acmeLeads.map((l) => buildLeadJourney(l, events));
  const accountJourney = buildAccountJourney(journeys);
  const focusJourney = journeys.find((j) => j.lead.email === email);
  const interpretation = interpretJourney(focusJourney, { signalMap, now: NOW });
  return buildSnapshot({ focusJourney, accountJourney, interpretation, now: NOW });
}

test('snapshot renders all nine sections in markdown and json', async () => {
  const { json, markdown } = await fixtureSnapshot();
  for (const section of ['who', 'interest', 'whyCare', 'doubts', 'say', 'channel', 'next', 'followUp', 'accountContext']) {
    assert.ok(json.sections[section], `json section ${section}`);
  }
  for (let i = 1; i <= 9; i++) assert.ok(markdown.includes(`## ${i}.`), `markdown section ${i}`);
});

test('snapshot surfaces the hand-raise, their own words, and the committee', async () => {
  const { json, markdown } = await fixtureSnapshot();
  assert.equal(json.journeyStage, 'decision');
  assert.ok(markdown.includes('Contact Sales'));
  assert.ok(markdown.includes('migrating 4 brand sites off LegacyCMS'), 'lead comments quoted verbatim');
  assert.ok(markdown.includes('Bob Smith'));
  assert.ok(markdown.includes('Carol Jones'));
  assert.ok(json.sections.channel.includes('inbound SLA'), 'form fill triggers same-day guidance');
  assert.equal(json.account.committee.activeCount, 3);
});

test('snapshot without a hand-raise leads with value, not a meeting ask', async () => {
  const { json } = await fixtureSnapshot('bob.smith@acme.com');
  assert.ok(json.sections.say.includes('offer one useful asset') || json.sections.say.includes('Promise value'));
  assert.ok(json.sections.doubts.some((d) => d.includes('Practitioner')));
});

test('full pipeline via mock client matches direct build (email path)', async () => {
  const signalMap = await buildSignalMap(await runRecon(mockClient()));
  const result = await runSnapshotPipeline(mockClient(), signalMap, {
    email: 'jane.doe@acme.com',
    lookbackDays: 120,
    now: NOW,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.focus.id, 101);
  assert.equal(result.accountJourney.members.length, 3, 'globex lead excluded from acme rollup');
  assert.equal(result.snapshot.json.journeyStage, 'decision');
});

test('pipeline returns a friendly error for unknown leads', async () => {
  const signalMap = await buildSignalMap(await runRecon(mockClient()));
  const result = await runSnapshotPipeline(mockClient(), signalMap, { email: 'nobody@nowhere.com', now: NOW });
  assert.ok(result.error.includes('nobody@nowhere.com'));
});

test('snapshot pipeline never requests ignore-mapped activity types', async () => {
  const signalMap = await buildSignalMap(await runRecon(mockClient()));
  const ignoredIds = Object.entries(signalMap.activityTypes)
    .filter(([, m]) => m.canonical === 'ignore')
    .map(([id]) => Number(id));
  assert.ok(ignoredIds.length > 0, 'fixture maps at least one type to ignore');

  const requestedTypeIds = new Set();
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    if (url.includes('/rest/v1/activities.json')) {
      for (const id of (new URL(url).searchParams.get('activityTypeIds') || '').split(',').filter(Boolean)) {
        requestedTypeIds.add(Number(id));
      }
    }
    return inner(url, opts);
  };
  const client = new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport });
  await runSnapshotPipeline(client, signalMap, { email: 'jane.doe@acme.com', now: NOW });
  for (const id of ignoredIds) {
    assert.ok(!requestedTypeIds.has(id), `ignore-mapped type ${id} was requested`);
  }
});

test('domain snapshot resolves leads from harvest state and focuses the most active lead', async () => {
  const signalMap = await buildSignalMap(await runRecon(mockClient()));
  // Harvest builds the domain→leadIds mapping the CLI hands to the pipeline.
  const harvest = await harvestOnce(mockClient(), signalMap, {
    state: { sinceTokens: {}, emittedKeys: [], patternState: {}, eventCache: {} },
    sinks: [],
    now: NOW,
    initialLookbackDays: 7,
  });
  const seedLeadIds = harvest.state.eventCache['acme.com']?.leadIds;
  assert.ok(seedLeadIds?.length, 'harvest state carries acme.com lead IDs');

  const result = await runSnapshotPipeline(mockClient(), signalMap, {
    domain: 'acme.com',
    seedLeadIds,
    lookbackDays: 120,
    now: NOW,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.accountJourney.domain, 'acme.com');
  assert.ok(result.accountJourney.members.length >= 2, 'account rollup includes colleagues');
  // Most active acme lead in the fixture is Jane Doe.
  assert.equal(result.focusJourney.lead.email, 'jane.doe@acme.com');
  assert.ok(result.snapshot.markdown.length > 200, 'produces a real brief');
});

test('domain snapshot without seed lead IDs errors instead of guessing', async () => {
  const signalMap = await buildSignalMap(await runRecon(mockClient()));
  const result = await runSnapshotPipeline(mockClient(), signalMap, { domain: 'acme.com', now: NOW });
  assert.ok(result.error.includes('acme.com'));
});
