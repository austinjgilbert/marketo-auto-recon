/**
 * Config loader — reads .env (next to package.json) into process.env without
 * overriding real environment variables, then exposes a typed config object.
 * Zero dependencies by design.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_DIR = join(PKG_ROOT, 'outputs');

function loadDotEnv() {
  const envPath = join(PKG_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}

/** Parse "15m" / "2h" / "90s" / plain seconds into milliseconds. */
export function parseInterval(text, fallbackMs) {
  if (!text) return fallbackMs;
  const m = String(text).trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000);
}

export function loadConfig(cliFlags = {}) {
  loadDotEnv();
  const mock = cliFlags.mock || process.env.MSE_MOCK === '1';
  return {
    mock,
    marketo: {
      baseUrl: (process.env.MARKETO_BASE_URL || '').replace(/\/+$/, ''),
      clientId: process.env.MARKETO_CLIENT_ID || '',
      clientSecret: process.env.MARKETO_CLIENT_SECRET || '',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    },
    sinks: {
      wranglerUrl: (process.env.WRANGLER_URL || '').replace(/\/+$/, ''),
      wranglerApiKey: process.env.WRANGLER_API_KEY || '',
      webhookUrl: process.env.SINK_WEBHOOK_URL || '',
      webhookSecret: process.env.SINK_WEBHOOK_SECRET || '',
    },
    lookbackDays: Number(process.env.MSE_LOOKBACK_DAYS || 90),
    harvestIntervalMs: parseInterval(process.env.MSE_HARVEST_INTERVAL, 15 * 60_000),
    outputDir: OUTPUT_DIR,
  };
}

export function ensureOutputDir() {
  mkdirSync(join(OUTPUT_DIR, 'snapshots'), { recursive: true });
  return OUTPUT_DIR;
}

/** Fail fast with a friendly message when live creds are missing. */
export function requireMarketoCreds(config) {
  if (config.mock) return;
  const missing = [];
  if (!config.marketo.baseUrl) missing.push('MARKETO_BASE_URL');
  if (!config.marketo.clientId) missing.push('MARKETO_CLIENT_ID');
  if (!config.marketo.clientSecret) missing.push('MARKETO_CLIENT_SECRET');
  if (missing.length) {
    console.error(
      `Missing ${missing.join(', ')}.\n` +
        `Copy .env.example to .env and fill in your Marketo REST credentials,\n` +
        `or run with --mock (MSE_MOCK=1) to demo against the bundled fixture instance.`,
    );
    process.exit(1);
  }
}
