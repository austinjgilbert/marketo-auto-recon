/**
 * Generic webhook sink — POSTs each signal batch as JSON. When a secret is
 * configured, the request carries an X-MSE-Timestamp header and an
 * X-MSE-Signature header: HMAC-SHA256 over `${timestamp}.${body}`. Signing
 * the timestamp lets receivers reject replays — verify the signature AND
 * that the timestamp is within a tolerance window (e.g. 5 minutes).
 */

import { createHmac } from 'node:crypto';

const HTTP_TIMEOUT_MS = 30_000;

export function signWebhookBody(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function createWebhookSink({ url, secret, fetchImpl = fetch, timeoutMs = HTTP_TIMEOUT_MS }) {
  return {
    name: 'webhook',
    async emit(signals) {
      if (!signals.length) return { ok: true, sent: 0 };
      const body = JSON.stringify({ source: 'marketo-signal-engine', signals });
      const headers = { 'content-type': 'application/json' };
      if (secret) {
        const timestamp = String(Date.now());
        headers['x-mse-timestamp'] = timestamp;
        headers['x-mse-signature'] = signWebhookBody(secret, timestamp, body);
      }
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.ok, sent: res.ok ? signals.length : 0, status: res.status };
    },
  };
}
