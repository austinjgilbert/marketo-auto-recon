import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketoClient, MarketoApiError } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';

function mockClient(transport = createMockTransport()) {
  return new MarketoClient({ baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport });
}

test('token is cached across requests', async () => {
  let tokenCalls = 0;
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    if (url.includes('/identity/oauth/token')) tokenCalls++;
    return inner(url, opts);
  };
  const client = mockClient(transport);
  await client.getActivityTypes();
  await client.getForms();
  await client.getPrograms();
  assert.equal(tokenCalls, 1);
});

test('expired token (602) triggers re-auth and retry', async () => {
  let calls = 0;
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    if (url.includes('/rest/v1/activities/types.json') && calls++ === 0) {
      return { status: 200, json: { success: false, errors: [{ code: '602', message: 'Token expired' }] } };
    }
    return inner(url, opts);
  };
  const types = await mockClient(transport).getActivityTypes();
  assert.ok(types.length > 0);
});

test('hard Marketo errors surface as MarketoApiError with the code', async () => {
  const transport = async (url) =>
    url.includes('/identity/')
      ? { status: 200, json: { access_token: 't', expires_in: 3600 } }
      : { status: 200, json: { success: false, errors: [{ code: '1003', message: 'Invalid value' }] } };
  await assert.rejects(() => mockClient(transport).getActivityTypes(), (err) => {
    assert.ok(err instanceof MarketoApiError);
    assert.equal(err.code, '1003');
    return true;
  });
});

test('client is read-only: GET everywhere, POST only for the OAuth handshake', async () => {
  const calls = [];
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET' });
    return inner(url, opts);
  };
  const client = mockClient(transport);
  await client.getActivityTypes();
  await client.describeLeadFields();
  await client.getLeadByEmail('jane.doe@acme.com');
  await client.getLeadActivities([101], { sinceDatetime: '2026-01-01T00:00:00Z' });
  for (const call of calls) {
    if (call.url.includes('/identity/oauth/token')) {
      assert.equal(call.method, 'POST', 'oauth handshake is the single allowed POST');
    } else {
      assert.equal(call.method, 'GET', `non-GET issued to ${call.url}`);
    }
  }
});

test('oauth secret travels in the POST body, never the URL', async () => {
  const oauthCalls = [];
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    if (url.includes('/identity/oauth/token')) oauthCalls.push({ url, opts });
    return inner(url, opts);
  };
  await mockClient(transport).getActivityTypes();
  assert.equal(oauthCalls.length, 1);
  assert.ok(!oauthCalls[0].url.includes('?'), 'no query string on the token URL');
  assert.ok(!oauthCalls[0].url.includes('client_secret'));
  const body = new URLSearchParams(oauthCalls[0].opts.body);
  assert.equal(body.get('client_secret'), 'y');
  assert.equal(body.get('grant_type'), 'client_credentials');
});

test('getLeadActivities chunks lead IDs to Marketo\'s 30-per-call cap', async () => {
  const leadIdParams = [];
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    if (url.includes('/rest/v1/activities.json')) {
      leadIdParams.push((new URL(url).searchParams.get('leadIds') || '').split(',').filter(Boolean));
    }
    return inner(url, opts);
  };
  const leadIds = Array.from({ length: 75 }, (_, i) => i + 1);
  await mockClient(transport).getLeadActivities(leadIds, { sinceDatetime: '2026-01-01T00:00:00Z' });
  assert.ok(leadIdParams.length >= 3, 'at least 3 lead chunks');
  for (const chunk of leadIdParams) assert.ok(chunk.length <= 30, `chunk of ${chunk.length} exceeds cap`);
  const seen = new Set(leadIdParams.flat().map(Number));
  assert.equal(seen.size, 75, 'every lead ID requested exactly once across chunks');
});

test('network errors and timeouts are retried', async () => {
  let attempts = 0;
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    if (url.includes('/rest/v1/activities/types.json') && attempts++ === 0) {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    return inner(url, opts);
  };
  const types = await mockClient(transport).getActivityTypes();
  assert.ok(types.length > 0, 'succeeded on retry after a timeout');
});

test('paging guard stops when moreResult is true but the token never advances', async () => {
  const logs = [];
  const transport = async (url, opts) => {
    if (url.includes('/identity/')) {
      return { status: 200, json: { access_token: 't', expires_in: 3600 } };
    }
    // Pathological API: always claims more, never advances the token, empty pages.
    return { status: 200, json: { success: true, result: [], nextPageToken: 'stuck', moreResult: true } };
  };
  const client = new MarketoClient({
    baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport,
    logger: (m) => logs.push(m),
  });
  let pages = 0;
  for await (const _page of client.iterateActivities({ nextPageToken: 'stuck' })) pages++;
  assert.ok(pages <= 2, 'loop terminated');
  assert.ok(logs.some((m) => m.includes('did not advance')), 'guard logged');
});

test('listAssets warns and flags when the inventory cap is hit', async () => {
  const logs = [];
  let truncated = null;
  const transport = async (url) => {
    if (url.includes('/identity/')) return { status: 200, json: { access_token: 't', expires_in: 3600 } };
    const params = new URL(url).searchParams;
    const offset = Number(params.get('offset') || 0);
    // Endless inventory: every page comes back full.
    return { status: 200, json: { success: true, result: Array.from({ length: 200 }, (_, i) => ({ id: offset + i })) } };
  };
  const client = new MarketoClient({
    baseUrl: 'https://m.mktorest.com', clientId: 'x', clientSecret: 'y', transport,
    logger: (m) => logs.push(m),
  });
  const out = await client.getForms({ max: 400, onTruncate: (path, max) => (truncated = { path, max }) });
  assert.equal(out.length, 400);
  assert.ok(logs.some((m) => m.includes('truncated')));
  assert.deepEqual(truncated, { path: '/rest/asset/v1/forms.json', max: 400 });
});

test('paging token flows through incremental activity pulls', async () => {
  const client = mockClient();
  const token = await client.getPagingToken('2026-07-01T00:00:00Z');
  assert.ok(token.startsWith('mock:'));
  let count = 0;
  let lastToken = null;
  for await (const page of client.iterateActivities({ nextPageToken: token })) {
    count += page.activities.length;
    lastToken = page.nextPageToken;
  }
  assert.ok(count > 0);
  assert.ok(lastToken > token, 'token advanced past consumed activities');
});
