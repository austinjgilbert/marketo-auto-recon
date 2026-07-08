/**
 * Marketo REST client — OAuth2 client-credentials, token caching, a rolling
 * rate limiter (Marketo's documented limit is 100 calls per 20 seconds per
 * instance), automatic re-auth on token expiry (error 602), backoff on rate
 * limit (606) and HTTP 429/5xx, and paging helpers for both the lead-database
 * API (nextPageToken) and the asset API (offset/maxReturn).
 *
 * READ-ONLY BY CONSTRUCTION: only GET requests are ever issued. There is no
 * code path that can create, update, or delete anything in Marketo.
 */

const RATE_WINDOW_MS = 20_000;
const RATE_MAX_CALLS = 90; // stay under Marketo's 100/20s with headroom
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MarketoApiError extends Error {
  constructor(message, { code, status, requestId } = {}) {
    super(message);
    this.name = 'MarketoApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

async function fetchTransport(url, { headers } = {}) {
  const res = await fetch(url, { method: 'GET', headers });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body — treated as an error below */
  }
  return { status: res.status, json };
}

export class MarketoClient {
  constructor({ baseUrl, clientId, clientSecret, transport, logger } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.transport = transport || fetchTransport;
    this.log = logger || (() => {});
    this.token = null;
    this.tokenExpiresAt = 0;
    this.callTimes = [];
    this.callCount = 0;
  }

  /* ── rate limiting ── */

  async throttle() {
    const now = Date.now();
    this.callTimes = this.callTimes.filter((t) => now - t < RATE_WINDOW_MS);
    if (this.callTimes.length >= RATE_MAX_CALLS) {
      const waitMs = RATE_WINDOW_MS - (now - this.callTimes[0]) + 50;
      this.log(`rate limit window full — waiting ${waitMs}ms`);
      await sleep(waitMs);
      return this.throttle();
    }
    this.callTimes.push(Date.now());
  }

  /* ── auth ── */

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) return this.token;
    const url =
      `${this.baseUrl}/identity/oauth/token` +
      `?grant_type=client_credentials&client_id=${encodeURIComponent(this.clientId)}` +
      `&client_secret=${encodeURIComponent(this.clientSecret)}`;
    const { status, json } = await this.transport(url, {});
    if (status !== 200 || !json?.access_token) {
      throw new MarketoApiError(
        `Auth failed (HTTP ${status}): ${json?.error_description || json?.error || 'no access_token in response'}`,
        { status },
      );
    }
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
    return this.token;
  }

  /* ── core request with retry ── */

  async request(path, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v)}`)
      .join('&');
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;

    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.throttle();
      const token = await this.getToken();
      this.callCount += 1;
      const { status, json } = await this.transport(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (status === 429 || status >= 500) {
        lastError = new MarketoApiError(`HTTP ${status} on ${path}`, { status });
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (!json) {
        throw new MarketoApiError(`Non-JSON response (HTTP ${status}) on ${path}`, { status });
      }
      if (json.success === false) {
        const err = json.errors?.[0] || {};
        // 601/602: token invalid/expired → refresh and retry. 606: rate limited.
        if (err.code === '601' || err.code === '602') {
          this.token = null;
          continue;
        }
        if (err.code === '606') {
          lastError = new MarketoApiError('Marketo rate limit (606)', { code: '606' });
          await sleep(2 ** attempt * 1500);
          continue;
        }
        throw new MarketoApiError(`Marketo error ${err.code}: ${err.message} (${path})`, {
          code: err.code,
          requestId: json.requestId,
        });
      }
      return json;
    }
    throw lastError || new MarketoApiError(`Retries exhausted on ${path}`);
  }

  /* ── lead database API ── */

  async getActivityTypes() {
    const json = await this.request('/rest/v1/activities/types.json');
    return json.result || [];
  }

  async describeLeadFields() {
    try {
      const json = await this.request('/rest/v1/leads/describe2.json');
      const fields = json.result?.[0]?.fields || json.result?.fields;
      if (fields) return fields;
    } catch {
      /* describe2 unavailable on some instances — fall back */
    }
    const json = await this.request('/rest/v1/leads/describe.json');
    return (json.result || []).map((f) => ({
      name: f.rest?.name || f.soap?.name || f.displayName,
      displayName: f.displayName,
      dataType: f.dataType,
      length: f.length,
      updateable: f.rest?.readOnly === false,
    }));
  }

  async getPagingToken(sinceDatetime) {
    const json = await this.request('/rest/v1/activities/pagingtoken.json', { sinceDatetime });
    return json.nextPageToken;
  }

  /**
   * Iterate activity pages. Marketo caps activityTypeIds at 10 per call —
   * callers pass chunks. Yields { activities, nextPageToken, moreResult }.
   */
  async *iterateActivities({ nextPageToken, activityTypeIds, leadIds, batchSize = 300 }) {
    let token = nextPageToken;
    for (;;) {
      const json = await this.request('/rest/v1/activities.json', {
        nextPageToken: token,
        activityTypeIds,
        leadIds,
        batchSize,
      });
      const activities = json.result || [];
      token = json.nextPageToken || token;
      yield { activities, nextPageToken: token, moreResult: json.moreResult === true };
      if (json.moreResult !== true) return;
    }
  }

  async getLeadsByFilter(filterType, filterValues, fields) {
    const json = await this.request('/rest/v1/leads.json', {
      filterType,
      filterValues: Array.isArray(filterValues) ? filterValues.join(',') : filterValues,
      fields: fields?.join(','),
      batchSize: 300,
    });
    return json.result || [];
  }

  async getLeadByEmail(email, fields) {
    const leads = await this.getLeadsByFilter('email', email, fields);
    return leads[0] || null;
  }

  /** Pull the full activity history for a set of leads since a datetime. */
  async getLeadActivities(leadIds, { sinceDatetime, activityTypeIds }) {
    const token = await this.getPagingToken(sinceDatetime);
    const all = [];
    // Marketo allows max 10 activityTypeIds per request.
    const chunks = [];
    const ids = activityTypeIds || [];
    for (let i = 0; i < Math.max(1, ids.length); i += 10) chunks.push(ids.slice(i, i + 10));
    for (const chunk of chunks) {
      for await (const page of this.iterateActivities({
        nextPageToken: token,
        activityTypeIds: chunk.length ? chunk : undefined,
        leadIds,
      })) {
        all.push(...page.activities);
      }
    }
    return all.sort((a, b) => new Date(a.activityDate) - new Date(b.activityDate));
  }

  /* ── asset API (offset/maxReturn paging) ── */

  async listAssets(path, { max = 500 } = {}) {
    const out = [];
    for (let offset = 0; out.length < max; offset += 200) {
      const json = await this.request(path, { maxReturn: 200, offset });
      const batch = json.result || [];
      out.push(...batch);
      if (batch.length < 200) break;
    }
    return out.slice(0, max);
  }

  getPrograms(opts) {
    return this.listAssets('/rest/asset/v1/programs.json', opts);
  }

  getSmartCampaigns(opts) {
    return this.listAssets('/rest/asset/v1/smartCampaigns.json', opts);
  }

  getForms(opts) {
    return this.listAssets('/rest/asset/v1/forms.json', opts);
  }

  getLandingPages(opts) {
    return this.listAssets('/rest/asset/v1/landingPages.json', opts);
  }

  getEmails(opts) {
    return this.listAssets('/rest/asset/v1/emails.json', opts);
  }

  /** Legacy campaign list (trigger campaigns visible to the API user). */
  async getCampaigns({ max = 500 } = {}) {
    const out = [];
    let token;
    for (;;) {
      const json = await this.request('/rest/v1/campaigns.json', { nextPageToken: token, batchSize: 300 });
      out.push(...(json.result || []));
      if (!json.nextPageToken || !(json.result || []).length || out.length >= max) break;
      token = json.nextPageToken;
    }
    return out.slice(0, max);
  }
}
