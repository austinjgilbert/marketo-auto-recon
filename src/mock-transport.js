/**
 * Mock transport — serves the bundled fixture instance through the exact same
 * URL surface the real Marketo REST API exposes, including working paging
 * tokens (encoded as `mock:<ISO datetime>`), so recon, snapshots, and the
 * incremental harvester all behave identically in demo/CI mode.
 */

import { INSTANCE } from '../fixtures/instance.js';

function ok(result, extra = {}) {
  return { status: 200, json: { requestId: 'mock', success: true, result, ...extra } };
}

function parseUrl(url) {
  const u = new URL(url);
  return { path: u.pathname, params: u.searchParams };
}

function pageAssets(list, params) {
  const offset = Number(params.get('offset') || 0);
  const maxReturn = Number(params.get('maxReturn') || 200);
  return list.slice(offset, offset + maxReturn);
}

export function createMockTransport(instance = INSTANCE) {
  return async function mockTransport(url) {
    const { path, params } = parseUrl(url);

    if (path === '/identity/oauth/token') {
      return { status: 200, json: { access_token: 'mock-token', expires_in: 3600, scope: 'mock@example.com' } };
    }
    if (path === '/rest/v1/activities/types.json') return ok(instance.activityTypes);
    if (path === '/rest/v1/leads/describe2.json') {
      return ok([{ name: 'lead', fields: instance.leadFields }]);
    }
    if (path === '/rest/v1/leads/describe.json') {
      return ok(instance.leadFields.map((f) => ({ displayName: f.displayName, dataType: f.dataType, rest: { name: f.name, readOnly: false } })));
    }
    if (path === '/rest/asset/v1/programs.json') return ok(pageAssets(instance.programs, params));
    if (path === '/rest/asset/v1/smartCampaigns.json') return ok(pageAssets(instance.smartCampaigns, params));
    if (path === '/rest/asset/v1/forms.json') return ok(pageAssets(instance.forms, params));
    if (path === '/rest/asset/v1/landingPages.json') return ok(pageAssets(instance.landingPages, params));
    if (path === '/rest/asset/v1/emails.json') return ok(pageAssets(instance.emails, params));
    if (path === '/rest/v1/campaigns.json') return ok(instance.campaigns);

    if (path === '/rest/v1/activities/pagingtoken.json') {
      const since = params.get('sinceDatetime') || '1970-01-01T00:00:00Z';
      return { status: 200, json: { requestId: 'mock', success: true, nextPageToken: `mock:${new Date(since).toISOString()}` } };
    }

    if (path === '/rest/v1/activities.json') {
      const token = params.get('nextPageToken') || 'mock:1970-01-01T00:00:00.000Z';
      const since = new Date(token.replace(/^mock:/, ''));
      const typeIds = (params.get('activityTypeIds') || '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      const leadIds = (params.get('leadIds') || '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      const matched = instance.activities
        .filter((a) => new Date(a.activityDate) > since)
        .filter((a) => (typeIds.length ? typeIds.includes(a.activityTypeId) : true))
        .filter((a) => (leadIds.length ? leadIds.includes(a.leadId) : true))
        .sort((a, b) => new Date(a.activityDate) - new Date(b.activityDate));
      // Advance the token past everything AVAILABLE (not just matched) so the
      // harvester's since-token moves forward exactly like the real API.
      const available = instance.activities.filter((a) => new Date(a.activityDate) > since);
      const maxDate = available.length
        ? new Date(Math.max(...available.map((a) => +new Date(a.activityDate)))).toISOString()
        : since.toISOString();
      return {
        status: 200,
        json: {
          requestId: 'mock',
          success: true,
          result: matched,
          nextPageToken: `mock:${maxDate}`,
          moreResult: false,
        },
      };
    }

    if (path === '/rest/v1/leads.json') {
      const filterType = params.get('filterType');
      const values = (params.get('filterValues') || '').split(',').filter(Boolean);
      const matched = instance.leads.filter((l) => {
        if (filterType === 'email') return values.includes(l.email);
        if (filterType === 'id') return values.map(Number).includes(l.id);
        if (filterType === 'company') return values.includes(l.company);
        return false;
      });
      return ok(matched);
    }

    return { status: 404, json: { requestId: 'mock', success: false, errors: [{ code: '603', message: `mock: no route for ${path}` }] } };
  };
}
