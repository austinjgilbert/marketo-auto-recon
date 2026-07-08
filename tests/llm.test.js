import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactForLlm, llmAvailable } from '../src/llm.js';

test('llmAvailable is false without an API key', () => {
  assert.equal(llmAvailable({ anthropic: { apiKey: '' } }), false);
  assert.equal(llmAvailable({ anthropic: { apiKey: 'sk-x' } }), true);
});

test('redactForLlm pseudonymizes emails consistently across texts', () => {
  const [a, b] = redactForLlm([
    'jane.doe@acme.com filled the form. Then jane.doe@acme.com visited pricing.',
    'Contact jane.doe@acme.com and bob.smith@acme.com.',
  ]);
  assert.ok(!a.includes('jane.doe@acme.com'));
  assert.ok(!b.includes('bob.smith@acme.com'));
  const alias = a.match(/person-\d+@redacted\.invalid/)[0];
  assert.ok(b.includes(alias), 'same email gets the same alias in every text');
  assert.notEqual(alias, b.match(/person-2@redacted\.invalid/)?.[0] ?? alias + 'x', 'different emails get different aliases');
});

test('redactForLlm removes surnames from journey context and email locals', () => {
  const context = {
    members: [
      { name: 'Jane Doe', title: 'VP Digital' },
      { personName: 'Bob Smith' },
    ],
  };
  const [out] = redactForLlm(
    ['Jane Doe (jane.doe@acme.com) pulled in Smith from the platform team. Doe is the champion.'],
    { context },
  );
  assert.ok(!/\bDoe\b/i.test(out), `surname "Doe" leaked: ${out}`);
  assert.ok(!/\bSmith\b/i.test(out), `surname "Smith" leaked: ${out}`);
  assert.ok(!out.includes('jane.doe@acme.com'));
  assert.ok(out.includes('Jane'), 'first names are kept so the story still reads');
});

test('redactForLlm leaves company domains and activity intact', () => {
  const [out] = redactForLlm(['3 pricing-page visits at acme.com in 48h; trial started.']);
  assert.ok(out.includes('acme.com'));
  assert.ok(out.includes('pricing-page visits'));
});
