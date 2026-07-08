/**
 * Generic webhook sink — POSTs each signal batch as JSON. When a secret is
 * configured, the body is signed with HMAC-SHA256 in the X-MSE-Signature
 * header so receivers can verify origin.
 */

import { createHmac } from 'node:crypto';

export function createWebhookSink({ url, secret, fetchImpl = fetch }) {
  return {
    name: 'webhook',
    async emit(signals) {
      if (!signals.length) return { ok: true, sent: 0 };
      const body = JSON.stringify({ source: 'marketo-signal-engine', signals });
      const headers = { 'content-type': 'application/json' };
      if (secret) {
        headers['x-mse-signature'] = createHmac('sha256', secret).update(body).digest('hex');
      }
      const res = await fetchImpl(url, { method: 'POST', headers, body });
      return { ok: res.ok, sent: res.ok ? signals.length : 0, status: res.status };
    },
  };
}
