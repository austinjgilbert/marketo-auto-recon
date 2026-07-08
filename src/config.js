/**
 * Config loader — reads .env (next to package.json) into process.env without
 * overriding real environment variables, then exposes a typed config object.
 * Zero dependencies by design.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fallback only — model names age faster than this code. Set ANTHROPIC_MODEL in .env. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

/** Parse dotenv text: CRLF-safe, strips quotes, cuts unquoted values at ` #` inline comments. */
export function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    let value = raw;
    const quoted = /^(["']).*\1$/.test(value);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values end at an inline comment: KEY=value  # note
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
      if (value.startsWith('#')) value = '';
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv() {
  const envPath = join(PKG_ROOT, '.env');
  if (!existsSync(envPath)) return;
  const parsed = parseDotEnv(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
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

/** Output dir: MSE_OUTPUT_DIR (global installs, read-only deploys) or <pkg>/outputs. */
export function getOutputDir() {
  return process.env.MSE_OUTPUT_DIR ? resolve(process.env.MSE_OUTPUT_DIR) : join(PKG_ROOT, 'outputs');
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
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      redact: process.env.MSE_LLM_REDACT === '1',
    },
    sinks: {
      wranglerUrl: (process.env.WRANGLER_URL || '').replace(/\/+$/, ''),
      wranglerApiKey: process.env.WRANGLER_API_KEY || '',
      webhookUrl: process.env.SINK_WEBHOOK_URL || '',
      webhookSecret: process.env.SINK_WEBHOOK_SECRET || '',
    },
    lookbackDays: Number(process.env.MSE_LOOKBACK_DAYS || 90),
    initialLookbackDays: Number(process.env.MSE_INITIAL_LOOKBACK_DAYS || 7),
    harvestIntervalMs: parseInterval(process.env.MSE_HARVEST_INTERVAL, 15 * 60_000),
    httpTimeoutMs: Number(process.env.MSE_HTTP_TIMEOUT || 30_000),
    assetMax: Number(process.env.MSE_ASSET_MAX || 500),
    dailyApiBudget: Number(process.env.MSE_DAILY_API_BUDGET || 10_000),
    emittedKeysCap: Number(process.env.MSE_EMITTED_KEYS_CAP || 50_000),
    outputDir: getOutputDir(),
  };
}

export function ensureOutputDir() {
  const dir = getOutputDir();
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  return dir;
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
