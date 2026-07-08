/**
 * Marketo REST client — OAuth2 client-credentials, token caching, a rolling
 * rate limiter (Marketo's documented limit is 100 calls per 20 seconds per
 * instance), automatic re-auth on token expiry (error 602), backoff on rate
 * limit (606), HTTP 429/5xx, and network timeouts, and paging helpers for
 * both the lead-database API (nextPageToken) and the asset API
 * (offset/maxReturn).
 *
 * READ-ONLY: every Marketo REST call is a GET. The single exception is the
 * OAuth token handshake, which POSTs the client credentials to the identity
 * endpoint (so the secret never appears in a URL/query string that proxies
 * and access logs would capture). A test enforces that no other method is
 * ever issued — there is no code path that can create, update, or delete
 * anything in Marketo.
 */

const RATE_WINDOW_MS = 20_000;
const RATE_MAX_CALLS = 90; // stay under Marketo's 100/20s with headroom
const MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const LEAD_IDS_MAX = 30; // Marketo caps leadIds per activities request
const TYPE_IDS_MAX = 10; // Marketo caps activityTypeIds per request
const MAX_PAGES = 5_000; // hard backstop against a paging loop that never ends

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

async function fetchTransport(url, { method = 'GET', headers, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body — treated as an error below */
  }
  return { status: res.status, json };
}

export class MarketoClient {
  constructor({ baseUrl, clientId, clientSecret, transport, logger, timeoutMs } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.transport = transport || fetchTransport;
    this.log = logger || (() => {});
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
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
    // POST body, never the query string: secrets in URLs end up in proxy and
    // access logs. This is the only non-GET request the client ever makes.
    const { status, json } = await this.transport(`${this.baseUrl}/identity/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
      timeoutMs: this.timeoutMs,
    });
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

      let status, json;
      try {
        ({ status, json } = await this.transport(url, {
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: this.timeoutMs,
        }));
      } catch (err) {
        // Timeouts (AbortError/TimeoutError) and transient network failures
        // are retryable — a stalled connection must never hang the daemon.
        lastError = new MarketoApiError(`Network error on ${path}: ${err.message}`, {});
        this.log(`network error on ${path} (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
        await sleep(2 ** attempt * 1000);
        continue;
      }

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
   * Guarded against non-advancing tokens and unbounded page counts.
   */
  async *iterateActivities({ nextPageToken, activityTypeIds, leadIds, batchSize = 300 }) {
    let token = nextPageToken;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES) {
        this.log(`paging backstop hit after ${MAX_PAGES} pages — stopping (possible API paging anomaly)`);
        return;
      }
      const json = await this.request('/rest/v1/activities.json', {
        nextPageToken: token,
        activityTypeIds,
        leadIds,
        batchSize,
      });
      const activities = json.result || [];
      const newToken = json.nextPageToken || token;
      const advanced = newToken !== token;
      token = newToken;
      yield { activities, nextPageToken: token, moreResult: json.moreResult === true };
      if (json.moreResult !== true) return;
      if (!advanced && !activities.length) {
        this.log('moreResult=true but the paging token did not advance and the page was empty — stopping to avoid a loop');
        return;
      }
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

  /**
   * Pull the full activity history for a set of leads since a datetime.
   * Chunks both axes of Marketo's caps: 10 activityTypeIds and 30 leadIds
   * per request — large buying committees would otherwise throw error 1003.
   *
   * `shouldStop` is checked between lead chunks so a caller-side budget can
   * halt a large pull; `onLeadChunkDone(ids)` fires after a lead chunk's
   * history is fully fetched, letting callers track which leads completed.
   */
  async getLeadActivities(leadIds, { sinceDatetime, activityTypeIds, shouldStop, onLeadChunkDone }) {
    const token = await this.getPagingToken(sinceDatetime);
    const all = [];
    const typeChunks = [];
    const ids = activityTypeIds || [];
    for (let i = 0; i < Math.max(1, ids.length); i += TYPE_IDS_MAX) typeChunks.push(ids.slice(i, i + TYPE_IDS_MAX));
    const leadChunks = [];
    const allLeadIds = leadIds || [];
    for (let i = 0; i < Math.max(1, allLeadIds.length); i += LEAD_IDS_MAX) {
      leadChunks.push(allLeadIds.slice(i, i + LEAD_IDS_MAX));
    }
    for (const leadChunk of leadChunks) {
      if (shouldStop?.()) {
        this.log(`getLeadActivities stopped early by caller — ${leadChunks.length} lead chunk(s) planned, stopping before this one`);
        break;
      }
      for (const chunk of typeChunks) {
        for await (const page of this.iterateActivities({
          nextPageToken: token,
          activityTypeIds: chunk.length ? chunk : undefined,
          leadIds: leadChunk.length ? leadChunk : undefined,
        })) {
          all.push(...page.activities);
        }
      }
      onLeadChunkDone?.(leadChunk);
    }
    return all.sort((a, b) => new Date(a.activityDate) - new Date(b.activityDate));
  }

  /* ── asset API (offset/maxReturn paging) ── */

  async listAssets(path, { max = 500, onTruncate } = {}) {
    const out = [];
    let lastBatchFull = false;
    for (let offset = 0; out.length < max; offset += 200) {
      const json = await this.request(path, { maxReturn: 200, offset });
      const batch = json.result || [];
      out.push(...batch);
      lastBatchFull = batch.length === 200;
      if (!lastBatchFull) break;
    }
    if (out.length >= max && lastBatchFull) {
      this.log(`asset inventory truncated at ${max} for ${path} — raise MSE_ASSET_MAX for a complete inventory`);
      onTruncate?.(path, max);
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
      const newToken = json.nextPageToken;
      if (!newToken || newToken === token || !(json.result || []).length || out.length >= max) break;
      token = newToken;
    }
    return out.slice(0, max);
  }
}
