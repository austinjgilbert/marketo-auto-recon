import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRecon, categorizeField, auditDataQuality, renderInstanceMapMarkdown } from '../src/recon.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';

function mockClient() {
  return new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport: createMockTransport() });
}

test('field categorization: scoring, lifecycle, utm, suspect', () => {
  assert.equal(categorizeField({ name: 'leadScore', displayName: 'Lead Score' }), 'scoring');
  assert.equal(categorizeField({ name: 'lifecycleStage__c', displayName: 'Lifecycle Stage' }), 'lifecycle');
  assert.equal(categorizeField({ name: 'utm_campaign__c', displayName: 'UTM Campaign' }), 'utm');
  assert.equal(categorizeField({ name: 'tempField_DO_NOT_USE__c', displayName: 'tempField DO NOT USE' }), 'suspect');
  assert.equal(categorizeField({ name: 'legacyRegion2014__c', displayName: 'Legacy Region (2014)' }), 'suspect');
});

test('"Threshold" does not false-positive the "old" suspect pattern', () => {
  const issues = auditDataQuality({
    leadFields: [],
    programs: [],
    smartCampaigns: [{ name: 'MQL Threshold Alert', status: 'Active' }],
    activityTypes: [],
  });
  assert.equal(issues.length, 0);
});

test('runRecon inventories the fixture instance with a DQ audit', async () => {
  const map = await runRecon(mockClient());
  assert.equal(map.counts.activityTypes, 16);
  assert.equal(map.counts.customActivityTypes, 3);
  assert.ok(map.counts.leadFields >= 20);
  assert.ok(map.fieldsByCategory.scoring?.length >= 1);
  assert.ok(map.fieldsByCategory.utm?.length >= 3);
  const kinds = map.dataQualityIssues.map((i) => i.kind);
  assert.ok(kinds.includes('suspect-field'));
  assert.ok(kinds.includes('stale-program'));
  assert.ok(kinds.includes('dead-custom-activity'));
});

test('markdown render includes every major section', async () => {
  const map = await runRecon(mockClient());
  const md = renderInstanceMapMarkdown(map);
  for (const heading of ['# Marketo instance map', '## Activity types', '## Lead fields by category', '## Programs', '## Forms', '## Data quality issues']) {
    assert.ok(md.includes(heading), heading);
  }
});
