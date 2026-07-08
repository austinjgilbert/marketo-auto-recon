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

test('client only ever issues GET requests (read-only guarantee)', async () => {
  const methods = new Set();
  const inner = createMockTransport();
  const transport = async (url, opts) => {
    methods.add(opts?.method || 'GET');
    return inner(url, opts);
  };
  const client = mockClient(transport);
  await client.getActivityTypes();
  await client.describeLeadFields();
  await client.getLeadByEmail('jane.doe@acme.com');
  await client.getLeadActivities([101], { sinceDatetime: '2026-01-01T00:00:00Z' });
  assert.deepEqual([...methods], ['GET']);
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
