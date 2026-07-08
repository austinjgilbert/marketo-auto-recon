import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalMap, classifyActivityType, classifyForm, classifyUrl, mapCoverage } from '../src/signal-map.js';
import { runRecon } from '../src/recon.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';

function mockClient() {
  return new MarketoClient({
    baseUrl: 'https://mock.mktorest.com',
    clientId: 'x',
    clientSecret: 'y',
    transport: createMockTransport(),
  });
}

test('standard activity types map with confidence 1', () => {
  assert.deepEqual(classifyActivityType({ id: 2, name: 'Fill Out Form' }).canonical, 'form_fill');
  assert.equal(classifyActivityType({ id: 1, name: 'Visit Webpage' }).confidence, 1);
  assert.equal(classifyActivityType({ id: 22, name: 'Change Score' }).canonical, 'score_change');
});

test('custom activity types classify by keyword with reduced confidence', () => {
  const webinar = classifyActivityType({ id: 100001, name: 'Attended Webinar (GoToWebinar)', description: '' });
  assert.equal(webinar.canonical, 'event_attended');
  assert.ok(webinar.confidence < 1);
  const legacy = classifyActivityType({ id: 100003, name: 'Legacy Sync Event', description: 'deprecated' });
  assert.equal(legacy.canonical, 'ignore');
});

test('unknown custom types return null (flagged for review, not guessed)', () => {
  assert.equal(classifyActivityType({ id: 100099, name: 'Zorble Flux', description: 'mystery' }), null);
});

test('form intent classification', () => {
  assert.equal(classifyForm({ name: 'Contact Sales' }).signalType, 'contact_us');
  assert.equal(classifyForm({ name: 'Request a Demo' }).signalType, 'demo_request');
  assert.equal(classifyForm({ name: 'Whitepaper Download' }).signalType, 'content_download');
  const generic = classifyForm({ name: 'Random Form 7' });
  assert.equal(generic.signalType, 'form_fill');
  assert.ok(generic.confidence < 0.5);
});

test('url classification with default rules and custom pattern override', () => {
  assert.equal(classifyUrl('https://x.com/pricing'), 'pricing');
  assert.equal(classifyUrl('/compare/legacycms'), 'competitor');
  assert.equal(classifyUrl('/docs/api'), 'docs');
  assert.equal(classifyUrl('/custom-cost-page', { pricing: ['/custom-cost-page'] }), 'pricing');
});

test('buildSignalMap covers the whole fixture instance and flags nothing unmapped', async () => {
  const instanceMap = await runRecon(mockClient());
  const map = await buildSignalMap(instanceMap);
  const coverage = mapCoverage(map, instanceMap);
  assert.equal(coverage.coveragePct, 100);
  assert.equal(map.unmapped.length, 0);
  assert.equal(map.activityTypes[2].canonical, 'form_fill');
  assert.equal(map.forms['Contact Sales'].signalType, 'contact_us');
  assert.ok(map.urlPatterns.pricing.includes('/pricing'));
});

test('llmAssist suggestions are applied but capped at 0.7 confidence and validated', async () => {
  const instanceMap = await runRecon(mockClient());
  instanceMap.activityTypes.push({ id: 100099, name: 'Zorble Flux', description: '', custom: true });
  const map = await buildSignalMap(instanceMap, {
    llmAssist: async () => [
      { id: 100099, canonical: 'event_attended', confidence: 0.99, rationale: 'llm says so' },
      { id: 100098, canonical: 'not_a_real_type', confidence: 0.9 },
    ],
  });
  assert.equal(map.activityTypes[100099].canonical, 'event_attended');
  assert.equal(map.activityTypes[100099].confidence, 0.7);
  assert.equal(map.activityTypes[100098], undefined);
});
