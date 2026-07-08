import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { purgeOutputs } from '../src/purge.js';

const NOW = new Date('2026-07-08T00:00:00.000Z');
const OLD_ISO = '2026-01-01T00:00:00.000Z'; // ~188 days before NOW
const RECENT_ISO = '2026-07-01T00:00:00.000Z'; // 7 days before NOW

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mse-purge-'));
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  return dir;
}

test('purge drops old jsonl rows and snapshot files, keeps recent ones', () => {
  const dir = setup();
  try {
    writeFileSync(
      join(dir, 'signals.jsonl'),
      [
        JSON.stringify({ signalType: 'contact_us', occurredAt: OLD_ISO, summary: 'old' }),
        JSON.stringify({ signalType: 'pricing_page_visit', occurredAt: RECENT_ISO, summary: 'recent' }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'signals-failed.jsonl'),
      JSON.stringify({ sink: 'webhook', failedAt: OLD_ISO, signal: { occurredAt: OLD_ISO } }) + '\n',
    );
    const oldSnap = join(dir, 'snapshots', 'old@x.com.md');
    const newSnap = join(dir, 'snapshots', 'new@x.com.md');
    writeFileSync(oldSnap, 'old');
    writeFileSync(newSnap, 'new');
    const oldTime = new Date(OLD_ISO);
    utimesSync(oldSnap, oldTime, oldTime);

    const report = purgeOutputs(dir, { olderThanDays: 90, now: NOW });

    assert.equal(report.signals.dropped, 1);
    assert.equal(report.signals.kept, 1);
    assert.ok(readFileSync(join(dir, 'signals.jsonl'), 'utf8').includes('recent'));
    assert.equal(report.deadLetter.dropped, 1);
    assert.equal(existsSync(join(dir, 'signals-failed.jsonl')), false, 'fully-drained jsonl removed');
    assert.equal(report.snapshots.dropped, 1);
    assert.equal(existsSync(oldSnap), false);
    assert.equal(existsSync(newSnap), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purge keeps rows it cannot parse or date (never destroys unreadable data)', () => {
  const dir = setup();
  try {
    writeFileSync(
      join(dir, 'signals.jsonl'),
      ['not json at all', JSON.stringify({ noTimestampField: true })].join('\n') + '\n',
    );
    const report = purgeOutputs(dir, { olderThanDays: 1, now: NOW });
    assert.equal(report.signals.dropped, 0);
    assert.equal(report.signals.kept, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purge is a no-op on an empty outputs dir', () => {
  const dir = setup();
  try {
    const report = purgeOutputs(dir, { olderThanDays: 90, now: NOW });
    assert.deepEqual(report.signals, { kept: 0, dropped: 0 });
    assert.deepEqual(report.deadLetter, { kept: 0, dropped: 0 });
    assert.deepEqual(report.snapshots, { kept: 0, dropped: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
