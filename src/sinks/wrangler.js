/**
 * Wrangler sink — adapts harvested signals to the Wrangler worker's
 * POST /signals/ingest-batch contract (the same endpoint the manual BigQuery
 * export uses). Rows resolve to accounts by domain on the worker side and flow
 * through the storeSignal normalizer: dedupe, decay, draft candidates, loop
 * triggers. Domains with no matching account are skipped by the worker
 * (named-accounts-only posture) — that is expected, not an error.
 */

const BATCH_MAX = 200;

/** One harvested signal → one ingest-batch row. Exported for tests. */
export function toIngestRow(signal) {
  return {
    domain: signal.domain,
    signalType: signal.signalType,
    source: 'marketo',
    strength: signal.strength,
    timestamp: signal.timestamp,
    summary: signal.summary,
    metadata: {
      ingestPath: 'marketo-signal-engine',
      marketoLeadId: signal.leadId,
      marketoActivityIds: signal.evidence,
      email: signal.email,
      dedupeKey: signal.dedupeKey,
    },
  };
}

export function createWranglerSink({ url, apiKey, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/+$/, '')}/signals/ingest-batch`;
  return {
    name: 'wrangler',
    async emit(signals) {
      if (!signals.length) return { ok: true, stored: 0, skipped: 0 };
      let stored = 0;
      let skipped = 0;
      for (let i = 0; i < signals.length; i += BATCH_MAX) {
        const rows = signals.slice(i, i + BATCH_MAX).map(toIngestRow);
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ source: 'marketo-signal-engine', rows }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { ok: false, stored, skipped, status: res.status, error: body.slice(0, 300) };
        }
        const json = await res.json().catch(() => ({}));
        stored += json.data?.stored ?? json.stored ?? 0;
        skipped += json.data?.skipped ?? json.skipped ?? 0;
      }
      return { ok: true, stored, skipped };
    },
  };
}
