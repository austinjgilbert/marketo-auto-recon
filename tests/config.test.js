import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseDotEnv, parseInterval, getOutputDir, assertSecureSinkUrl, PKG_ROOT } from '../src/config.js';

test('parseDotEnv handles CRLF line endings (Windows-edited .env)', () => {
  const parsed = parseDotEnv('MARKETO_BASE_URL=https://abc.mktorest.com\r\nMARKETO_CLIENT_ID=id-123\r\n');
  assert.equal(parsed.MARKETO_BASE_URL, 'https://abc.mktorest.com');
  assert.equal(parsed.MARKETO_CLIENT_ID, 'id-123');
  assert.ok(!parsed.MARKETO_CLIENT_ID.includes('\r'), 'no trailing carriage return');
});

test('parseDotEnv cuts unquoted values at inline comments', () => {
  const parsed = parseDotEnv([
    'KEY1=value1  # this is a note',
    'KEY2="quoted # not a comment"',
    "KEY3='also # kept'",
    'KEY4=plain',
    '# FULL_COMMENT=ignored',
    'KEY5=',
  ].join('\n'));
  assert.equal(parsed.KEY1, 'value1');
  assert.equal(parsed.KEY2, 'quoted # not a comment');
  assert.equal(parsed.KEY3, 'also # kept');
  assert.equal(parsed.KEY4, 'plain');
  assert.equal(parsed.FULL_COMMENT, undefined);
  assert.equal(parsed.KEY5, '');
});

test('parseInterval', () => {
  assert.equal(parseInterval('15m', 0), 15 * 60_000);
  assert.equal(parseInterval('2h', 0), 2 * 3_600_000);
  assert.equal(parseInterval('90s', 0), 90_000);
  assert.equal(parseInterval('45', 0), 45_000);
  assert.equal(parseInterval('junk', 123), 123);
  assert.equal(parseInterval(undefined, 456), 456);
});

test('getOutputDir honors MSE_OUTPUT_DIR and defaults to <pkg>/outputs', () => {
  const prior = process.env.MSE_OUTPUT_DIR;
  try {
    delete process.env.MSE_OUTPUT_DIR;
    assert.equal(getOutputDir(), resolve(PKG_ROOT, 'outputs'));
    process.env.MSE_OUTPUT_DIR = '/tmp/mse-custom';
    assert.equal(getOutputDir(), resolve('/tmp/mse-custom'));
  } finally {
    if (prior === undefined) delete process.env.MSE_OUTPUT_DIR;
    else process.env.MSE_OUTPUT_DIR = prior;
  }
});

test('assertSecureSinkUrl: https ok, plain http refused, localhost exempt', () => {
  assert.doesNotThrow(() => assertSecureSinkUrl('https://hooks.example.com/mse', 'SINK_WEBHOOK_URL'));
  assert.doesNotThrow(() => assertSecureSinkUrl('http://localhost:8787/ingest', 'SINK_WEBHOOK_URL'));
  assert.doesNotThrow(() => assertSecureSinkUrl('http://127.0.0.1:3000/x', 'WRANGLER_URL'));
  assert.throws(() => assertSecureSinkUrl('http://hooks.example.com/mse', 'SINK_WEBHOOK_URL'), /must use https/);
  assert.throws(() => assertSecureSinkUrl('ftp://example.com/x', 'SINK_WEBHOOK_URL'), /must use https/);
  assert.throws(() => assertSecureSinkUrl('not a url', 'SINK_WEBHOOK_URL'), /not a valid URL/);
});
