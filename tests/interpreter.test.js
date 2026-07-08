import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveJourneyStage, detectStalls, computeVelocity, interpretJourney,
  extractEventSignals, extractPatternSignals, nextPatternState,
} from '../src/interpreter.js';
import { normalizeActivities, buildLeadJourney, buildAccountJourney } from '../src/normalizer.js';
import { buildSignalMap } from '../src/signal-map.js';
import { runRecon } from '../src/recon.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';
import { ACTIVITIES, LEADS, MOCK_NOW } from '../fixtures/instance.js';

const NOW = new Date(MOCK_NOW);

async function fixtureWorld() {
  const client = new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport: createMockTransport() });
  const signalMap = await buildSignalMap(await runRecon(client));
  const events = normalizeActivities(ACTIVITIES, signalMap);
  const acmeLeads = LEADS.filter((l) => l.email.endsWith('@acme.com'));
  const journeys = acmeLeads.map((l) => buildLeadJourney(l, events));
  const account = buildAccountJourney(journeys);
  return { signalMap, events, journeys, account };
}

test('journey stages: Jane=decision, Bob=decision (trial start), Carol=decision (pricing visit)', async () => {
  const { journeys } = await fixtureWorld();
  const stage = (email) => deriveJourneyStage(journeys.find((j) => j.lead.email === email), NOW).stage;
  assert.equal(stage('jane.doe@acme.com'), 'decision');
  assert.equal(stage('bob.smith@acme.com'), 'decision');
  assert.equal(stage('carol.jones@acme.com'), 'decision');
});

test('docs-only browsing without a trial is consideration', () => {
  const journey = {
    lead: { status: 'Engaged' },
    events: [
      { ts: '2026-06-01T10:00:00.000Z', canonicalType: 'web_visit', urlCategory: 'docs' },
      { ts: '2026-06-02T10:00:00.000Z', canonicalType: 'web_visit', urlCategory: 'product' },
    ],
  };
  assert.equal(deriveJourneyStage(journey, NOW).stage, 'consideration');
});

test('customer status short-circuits stage detection', () => {
  const journey = { lead: { status: 'Customer' }, events: [] };
  assert.equal(deriveJourneyStage(journey, NOW).stage, 'customer');
});

test('stall detection: gap, repeat-without-progress, no trailing stall for active leads', async () => {
  const { journeys, signalMap } = await fixtureWorld();
  const jane = journeys.find((j) => j.lead.email === 'jane.doe@acme.com');
  const stalls = detectStalls(jane.events, { now: NOW, stallGapDays: signalMap.thresholds.stallGapDays });
  assert.ok(stalls.some((s) => s.kind === 'gap' && s.days >= 30), 'mid-journey gap detected');
  assert.ok(!stalls.some((s) => s.kind === 'trailing'), 'Jane is active — no trailing stall');
});

test('trailing stall fires for engaged-then-silent leads', () => {
  const events = ['2026-01-01', '2026-01-02', '2026-01-03'].map((d, i) => ({
    id: i, ts: `${d}T10:00:00.000Z`, canonicalType: 'web_visit', asset: 'Docs', urlCategory: 'docs', leadId: 1,
  }));
  const stalls = detectStalls(events, { now: new Date('2026-03-01T00:00:00Z'), stallGapDays: 21 });
  assert.ok(stalls.some((s) => s.kind === 'trailing' && !s.resumed));
});

test('velocity trend', async () => {
  const { journeys } = await fixtureWorld();
  const jane = journeys.find((j) => j.lead.email === 'jane.doe@acme.com');
  const v = computeVelocity(jane.events, NOW);
  assert.equal(v.trend, 'rising');
  assert.ok(v.recent14d > 0);
  assert.equal(computeVelocity([], NOW).trend, 'dormant');
});

test('event signals: contact_us, pricing_page_visit, score_jump, product_signup, mql', async () => {
  const { signalMap, events, journeys } = await fixtureWorld();
  const leadById = new Map(journeys.map((j) => [j.lead.id, { email: j.lead.email, name: j.lead.name, title: j.lead.title }]));
  const signals = extractEventSignals(events, { domain: 'acme.com', leadById, signalMap });
  const types = signals.map((s) => s.signalType);
  for (const expected of ['contact_us', 'pricing_page_visit', 'score_jump', 'product_signup', 'mql']) {
    assert.ok(types.includes(expected), `missing ${expected} in ${types}`);
  }
  const contact = signals.find((s) => s.signalType === 'contact_us');
  assert.equal(contact.email, 'jane.doe@acme.com');
  assert.ok(contact.summary.includes('Contact Sales'));
  assert.ok(contact.dedupeKey.startsWith('acme.com:contact_us:101:'));
  assert.ok(contact.evidence.length > 0);
});

test('small score changes do not emit score_jump', async () => {
  const { signalMap } = await fixtureWorld();
  const signals = extractEventSignals(
    [{ id: 1, leadId: 1, ts: '2026-07-01T00:00:00.000Z', canonicalType: 'score_change', scoreDelta: 3, attrs: {} }],
    { domain: 'x.com', signalMap },
  );
  assert.equal(signals.filter((s) => s.signalType === 'score_jump').length, 0);
});

test('pattern signals: content_binge + intent_surge fire; committee_growth only vs known baseline', async () => {
  const { signalMap, account } = await fixtureWorld();

  const noBaseline = extractPatternSignals(account, { signalMap, now: NOW, state: {} });
  assert.ok(noBaseline.some((s) => s.signalType === 'content_binge'));
  assert.ok(noBaseline.some((s) => s.signalType === 'intent_surge'));
  assert.equal(noBaseline.filter((s) => s.signalType === 'committee_growth').length, 0, 'no growth without baseline');

  const withBaseline = extractPatternSignals(account, {
    signalMap, now: NOW, state: { knownLeadIds: [101, 102] },
  });
  const growth = withBaseline.filter((s) => s.signalType === 'committee_growth');
  assert.equal(growth.length, 1);
  assert.equal(growth[0].email, 'carol.jones@acme.com');
});

test('reactivation fires when a previously-stalled lead becomes active', async () => {
  const { signalMap, account } = await fixtureWorld();
  const signals = extractPatternSignals(account, {
    signalMap, now: NOW, state: { knownLeadIds: [101, 102, 103], stalledLeadIds: [102] },
  });
  const reactivation = signals.filter((s) => s.signalType === 'reactivation');
  assert.equal(reactivation.length, 1);
  assert.equal(reactivation[0].email, 'bob.smith@acme.com');
});

test('nextPatternState records active leads and current trailing stalls', async () => {
  const { signalMap, account } = await fixtureWorld();
  const state = nextPatternState(account, { signalMap, now: NOW });
  assert.deepEqual([...state.knownLeadIds].sort(), [101, 102, 103]);
  assert.equal(state.stalledLeadIds.length, 0, 'everyone recently active at mockNow');
});

test('interpretJourney wraps stage + stalls + velocity', async () => {
  const { signalMap, journeys } = await fixtureWorld();
  const out = interpretJourney(journeys[0], { signalMap, now: NOW });
  assert.ok(out.stage.stage);
  assert.ok(Array.isArray(out.stalls));
  assert.ok(out.velocity.trend);
});
