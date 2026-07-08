/**
 * Drift detection — the map is a snapshot of the instance at `mse map` time,
 * but Marketo instances keep evolving: a custom activity type or form created
 * after mapping would otherwise be invisible forever (the harvester polls only
 * mapped type IDs). Once per day the harvest loop re-inventories activity
 * types and forms (2 API calls), diffs them against the signal map, logs
 * loudly, and hot-adds anything the heuristics can classify with high
 * confidence for the current run. The hand-edited signal-map.json on disk is
 * never rewritten — drift findings persist in harvest state and surface in
 * `mse explain`.
 */

import { classifyActivityType, classifyForm } from './signal-map.js';

export const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HOT_ADD_MIN_CONFIDENCE = 0.75;

export function driftCheckDue(state, now = new Date()) {
  if (!state.lastDriftCheckAt) return true;
  return now.getTime() - new Date(state.lastDriftCheckAt).getTime() >= DRIFT_CHECK_INTERVAL_MS;
}

/**
 * Re-inventory activity types + forms and diff against the signal map.
 * Mutates `signalMap` in memory only: hot-adds high-confidence classifications
 * so this run's harvest already polls the new types. Returns the drift record
 * to persist in state (or null when nothing changed).
 */
export async function detectDrift(client, signalMap, { now = new Date(), log = () => {} } = {}) {
  const [liveTypes, liveForms] = await Promise.all([
    client.getActivityTypes(),
    client.getForms().catch(() => []),
  ]);

  const knownTypeIds = new Set([
    ...Object.keys(signalMap.activityTypes).map(Number),
    ...(signalMap.unmapped || []).filter((u) => u.kind === 'activityType').map((u) => u.id),
  ]);
  const knownFormNames = new Set(Object.keys(signalMap.forms || {}));

  const newTypes = liveTypes.filter((t) => !knownTypeIds.has(t.id));
  const newForms = liveForms.filter((f) => !knownFormNames.has(f.name));
  if (!newTypes.length && !newForms.length) return null;

  const record = { detectedAt: now.toISOString(), newActivityTypes: [], newForms: [] };

  for (const type of newTypes) {
    const hit = classifyActivityType(type);
    const hotAdded = Boolean(hit && hit.confidence >= HOT_ADD_MIN_CONFIDENCE);
    if (hotAdded) {
      signalMap.activityTypes[type.id] = { name: type.name, ...hit, hotAdded: true };
    } else {
      signalMap.unmapped = [
        ...(signalMap.unmapped || []),
        { kind: 'activityType', id: type.id, name: type.name, description: type.description },
      ];
    }
    record.newActivityTypes.push({
      id: type.id,
      name: type.name,
      hotAdded,
      canonical: hotAdded ? hit.canonical : null,
      confidence: hit?.confidence ?? null,
    });
    log(
      `DRIFT: new activity type [${type.id}] "${type.name}" — ` +
        (hotAdded
          ? `hot-mapped to ${hit.canonical} (confidence ${hit.confidence}) for this run`
          : `unmapped; re-run \`mse map\` and review signal-map.json`),
    );
  }

  for (const form of newForms) {
    const hit = classifyForm(form);
    const hotAdded = hit.confidence >= HOT_ADD_MIN_CONFIDENCE;
    if (hotAdded) signalMap.forms[form.name] = { ...hit, hotAdded: true };
    record.newForms.push({
      id: form.id,
      name: form.name,
      hotAdded,
      signalType: hit.signalType,
      confidence: hit.confidence,
    });
    log(
      `DRIFT: new form "${form.name}" — ` +
        (hotAdded
          ? `hot-mapped to intent ${hit.signalType} (confidence ${hit.confidence}) for this run`
          : `treated as generic form_fill; re-run \`mse map\` and review signal-map.json`),
    );
  }

  log(
    `DRIFT SUMMARY: ${record.newActivityTypes.length} new activity type(s), ${record.newForms.length} new form(s). ` +
      `The signal-map.json on disk was NOT changed — re-run \`mse map\` (then re-review) to make these permanent.`,
  );
  return record;
}
