/** JSONL sink — appends every signal to outputs/signals.jsonl. Always on. */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function createJsonlSink(outputDir) {
  const file = join(outputDir, 'signals.jsonl');
  return {
    name: 'jsonl',
    async emit(signals) {
      if (!signals.length) return { ok: true, written: 0 };
      mkdirSync(dirname(file), { recursive: true });
      const lines = signals.map((s) => JSON.stringify(s)).join('\n') + '\n';
      appendFileSync(file, lines, 'utf8');
      return { ok: true, written: signals.length, file };
    },
  };
}
