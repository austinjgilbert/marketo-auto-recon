import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActivities, guessRole, domainOf, isFreemailDomain, buildLeadJourney, buildAccountJourney, extractTopics } from '../src/normalizer.js';
import { buildSignalMap } from '../src/signal-map.js';
import { runRecon } from '../src/recon.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';
import { ACTIVITIES, LEADS } from '../fixtures/instance.js';

async function fixtureSignalMap() {
  const client = new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport: createMockTransport() });
  return buildSignalMap(await runRecon(client));
}

test('normalizeActivities produces chronological canonical events and drops ignored types', async () => {
  const map = await fixtureSignalMap();
  const events = normalizeActivities(ACTIVITIES, map);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].ts >= events[i - 1].ts, 'chronological');
  assert.ok(events.every((e) => e.canonicalType !== 'ignore'));
  const contactFill = events.find((e) => e.asset === 'Contact Sales');
  assert.equal(contactFill.canonicalType, 'form_fill');
  assert.equal(contactFill.formIntent, 'contact_us');
  const pricing = events.find((e) => e.url === '/pricing');
  assert.equal(pricing.urlCategory, 'pricing');
  const score = events.find((e) => e.canonicalType === 'score_change');
  assert.equal(typeof score.scoreDelta, 'number');
});

test('guessRole lanes', () => {
  assert.deepEqual(guessRole('VP Digital Experience'), { role: 'executive', lane: 'ATL' });
  assert.deepEqual(guessRole('Director of Marketing'), { role: 'manager', lane: 'ATL' });
  assert.deepEqual(guessRole('Web Engineer'), { role: 'practitioner', lane: 'BTL' });
  assert.equal(guessRole('').role, 'unknown');
});

test('domainOf prefers email domain, skips freemail, falls back to website', () => {
  assert.equal(domainOf({ email: 'a@acme.com' }), 'acme.com');
  assert.equal(domainOf({ email: 'a@gmail.com', website: 'https://www.acme.com/x' }), 'acme.com');
  assert.equal(domainOf({}), null);
});

test('freemail detection matches exact domains and country variants, never substrings', () => {
  // Exact providers and dotted country variants are freemail.
  for (const d of ['gmail.com', 'googlemail.com', 'yahoo.co.uk', 'hotmail.fr', 'outlook.com.br', 'proton.me', 'icloud.com']) {
    assert.equal(isFreemailDomain(d), true, `${d} should be freemail`);
  }
  // Corporate domains that merely CONTAIN a provider name are not.
  for (const d of ['notgmail.com', 'gmailtools.io', 'liverpool.ac.uk', 'outlookconsulting.com', 'protonstack.dev']) {
    assert.equal(isFreemailDomain(d), false, `${d} should attribute to an account`);
  }
  // domainOf attributes the corporate lookalike instead of skipping it.
  assert.equal(domainOf({ email: 'jane@notgmail.com' }), 'notgmail.com');
  assert.equal(domainOf({ email: 'jane@yahoo.co.uk', website: 'https://corp.example' }), 'corp.example');
});

test('lead journey + account rollup', async () => {
  const map = await fixtureSignalMap();
  const events = normalizeActivities(ACTIVITIES, map);
  const acmeLeads = LEADS.filter((l) => l.email.endsWith('@acme.com'));
  const journeys = acmeLeads.map((l) => buildLeadJourney(l, events));
  const jane = journeys.find((j) => j.lead.email === 'jane.doe@acme.com');
  assert.ok(jane.events.length >= 15);
  assert.equal(jane.lead.domain, 'acme.com');
  assert.ok(jane.firstSeen < jane.lastSeen);
  assert.ok(jane.counts.form_fill >= 3);

  const account = buildAccountJourney(journeys);
  assert.equal(account.domain, 'acme.com');
  assert.equal(account.committee.size, 3);
  assert.equal(account.committee.activeCount, 3);
  assert.equal(account.committee.lanes.ATL, 2);
  assert.equal(account.committee.lanes.BTL, 1);
  assert.equal(account.timeline.length, journeys.reduce((n, j) => n + j.events.length, 0));
});

test('topics ignore plumbing events (score changes do not become topics)', async () => {
  const map = await fixtureSignalMap();
  const events = normalizeActivities(ACTIVITIES.filter((a) => a.leadId === 101), map);
  const topics = extractTopics(events).map((t) => t.topic);
  assert.ok(!topics.includes('lead'), `unexpected "lead" topic in ${topics}`);
  assert.ok(!topics.includes('score'), `unexpected "score" topic in ${topics}`);
  assert.ok(topics.includes('content') || topics.includes('pricing') || topics.includes('readiness'));
});
