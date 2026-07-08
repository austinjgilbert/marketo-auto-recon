/**
 * Data retention — `mse purge --older-than <days>`.
 *
 * outputs/ holds PII (lead emails, names, form comments) in plaintext:
 * signals.jsonl, signals-failed.jsonl, and the snapshot files. Nothing in the
 * pipeline ever deletes them, so a lead removed in Marketo would otherwise
 * live on locally forever — a problem for GDPR-style deletion obligations.
 * Purge drops jsonl rows and snapshot files older than the cutoff. The state
 * event cache is already bounded (journey-window pruning + stale-domain
 * eviction in the harvester), so it is reported, not touched.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PURGE_DAYS = 90;

/** Timestamp of a jsonl row, whatever shape it is (signal or dead-letter). */
function rowTimestamp(row) {
  return row.failedAt || row.occurredAt || row.detectedAt || row.signal?.occurredAt || row.signal?.detectedAt || null;
}

/** Rewrite a jsonl file keeping only rows at/after the cutoff (atomic). */
function purgeJsonl(file, cutoffIso) {
  if (!existsSync(file)) return { kept: 0, dropped: 0 };
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    let ts = null;
    try {
      ts = rowTimestamp(JSON.parse(line));
    } catch {
      // Unparseable line: keep it — purge must never destroy data it can't read.
    }
    if (ts && ts < cutoffIso) dropped++;
    else kept.push(line);
  }
  if (!dropped) return { kept: kept.length, dropped: 0 };
  if (kept.length) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
    renameSync(tmp, file);
  } else {
    unlinkSync(file);
  }
  return { kept: kept.length, dropped };
}

/** Delete snapshot files whose mtime is older than the cutoff. */
function purgeSnapshots(dir, cutoffMs) {
  if (!existsSync(dir)) return { kept: 0, dropped: 0 };
  let kept = 0;
  let dropped = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoffMs) {
      unlinkSync(path);
      dropped++;
    } else {
      kept++;
    }
  }
  return { kept, dropped };
}

/**
 * Purge PII-bearing artifacts older than `olderThanDays` from `outputDir`.
 * Returns a per-artifact report for the CLI to print.
 */
export function purgeOutputs(outputDir, { olderThanDays = DEFAULT_PURGE_DAYS, now = new Date() } = {}) {
  const cutoffMs = now.getTime() - olderThanDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const signals = purgeJsonl(join(outputDir, 'signals.jsonl'), cutoffIso);
  const deadLetter = purgeJsonl(join(outputDir, 'signals-failed.jsonl'), cutoffIso);
  const snapshots = purgeSnapshots(join(outputDir, 'snapshots'), cutoffMs);

  // Event cache is self-bounding; report its footprint so operators can see it.
  let eventCacheDomains = 0;
  const stateFile = join(outputDir, '.state.json');
  if (existsSync(stateFile)) {
    try {
      eventCacheDomains = Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).eventCache || {}).length;
    } catch {
      // Corrupt state is the harvester's problem, not purge's.
    }
  }

  return { cutoffIso, olderThanDays, signals, deadLetter, snapshots, eventCacheDomains };
}
