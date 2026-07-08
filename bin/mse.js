#!/usr/bin/env node
/**
 * mse — Marketo Signal Engine CLI.
 *
 *   mse auth                         validate credentials, print instance identity
 *   mse recon                        inventory the instance -> outputs/marketo-instance-map.{md,json}
 *   mse map [--llm]                  classify inventory -> outputs/signal-map.json (hand-editable)
 *   mse test --email a@b.com         run one lead through every stage, verbose
 *   mse snapshot --email a@b.com     seller snapshot -> outputs/snapshots/<email>.{md,json}
 *   mse snapshot --domain b.com        (account-level: uses the most active lead as focus)
 *   mse harvest [--once]             incremental signal harvesting to configured sinks
 *   mse harvest --daemon [--interval 15m]
 *   mse harvest --replay-failed      re-send signals whose sink delivery failed
 *   mse explain                      what the engine found + recommended next actions
 *   mse purge [--older-than 90]      delete PII-bearing artifacts older than N days
 *
 * Global flags: --mock (or MSE_MOCK=1) runs against the bundled fixture instance.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ensureOutputDir, requireMarketoCreds, parseInterval, assertSecureSinkUrl } from '../src/config.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';
import { runRecon, renderInstanceMapMarkdown } from '../src/recon.js';
import { buildSignalMap, mapCoverage } from '../src/signal-map.js';
import { runSnapshotPipeline } from '../src/pipeline.js';
import { harvestOnce, harvestDaemon, loadState, saveState, acquireLock, appendFailedDeliveries, replayFailedDeliveries } from '../src/harvester.js';
import { createJsonlSink } from '../src/sinks/jsonl.js';
import { createWebhookSink } from '../src/sinks/webhook.js';
import { createWranglerSink } from '../src/sinks/wrangler.js';
import { makeLlmMappingAssist, generateNarrativeSnapshot, llmAvailable } from '../src/llm.js';
import { purgeOutputs, DEFAULT_PURGE_DAYS } from '../src/purge.js';
import { MOCK_NOW } from '../fixtures/instance.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
}

function makeClient(config) {
  if (config.mock) {
    return new MarketoClient({
      baseUrl: 'https://mock.mktorest.com',
      clientId: 'mock',
      clientSecret: 'mock',
      transport: createMockTransport(),
      timeoutMs: config.httpTimeoutMs,
    });
  }
  return new MarketoClient({
    baseUrl: config.marketo.baseUrl,
    clientId: config.marketo.clientId,
    clientSecret: config.marketo.clientSecret,
    timeoutMs: config.httpTimeoutMs,
    logger: (msg) => process.env.MSE_DEBUG && console.error(`[marketo] ${msg}`),
  });
}

function nowFor(config) {
  return config.mock ? new Date(MOCK_NOW) : new Date();
}

function loadJson(path, friendlyName) {
  if (!existsSync(path)) {
    console.error(`Missing ${friendlyName} (${path}). Run the earlier stage first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildSinks(config) {
  const sinks = [createJsonlSink(config.outputDir)];
  if (config.sinks.webhookUrl) {
    assertSecureSinkUrl(config.sinks.webhookUrl, 'SINK_WEBHOOK_URL');
    sinks.push(createWebhookSink({ url: config.sinks.webhookUrl, secret: config.sinks.webhookSecret }));
  }
  if (config.sinks.wranglerUrl && config.sinks.wranglerApiKey) {
    assertSecureSinkUrl(config.sinks.wranglerUrl, 'WRANGLER_URL');
    sinks.push(createWranglerSink({ url: config.sinks.wranglerUrl, apiKey: config.sinks.wranglerApiKey }));
  }
  return sinks;
}

/* ── commands ── */

async function cmdAuth(config) {
  const client = makeClient(config);
  const types = await client.getActivityTypes();
  console.log(`Authenticated against ${config.mock ? 'MOCK instance' : config.marketo.baseUrl}.`);
  console.log(`API user can see ${types.length} activity types. Ready for \`mse recon\`.`);
}

async function cmdRecon(config) {
  const client = makeClient(config);
  const outputDir = ensureOutputDir();
  console.error('Inventorying instance (activity types, fields, programs, forms, assets)...');
  const map = await runRecon(client, { assetMax: config.assetMax });
  writeFileSync(join(outputDir, 'marketo-instance-map.json'), JSON.stringify(map, null, 2));
  writeFileSync(join(outputDir, 'marketo-instance-map.md'), renderInstanceMapMarkdown(map));
  console.log(`Instance map written:`);
  console.log(`  ${join(outputDir, 'marketo-instance-map.md')}`);
  console.log(`  ${join(outputDir, 'marketo-instance-map.json')}`);
  console.log(`Counts: ${JSON.stringify(map.counts)}`);
  if (map.dataQualityIssues.length) {
    console.log(`\n${map.dataQualityIssues.length} data-quality issue(s) flagged — see the map's "Data quality issues" section.`);
  }
  console.log(`\nNext: \`mse map\` to build the signal taxonomy.`);
}

async function cmdMap(config, flags) {
  const outputDir = ensureOutputDir();
  const instanceMap = loadJson(join(outputDir, 'marketo-instance-map.json'), 'instance map');
  const llmAssist = flags.llm ? makeLlmMappingAssist(config) : null;
  if (flags.llm && !llmAssist) console.error('--llm requested but ANTHROPIC_API_KEY is not set — heuristics only.');
  const signalMap = await buildSignalMap(instanceMap, { llmAssist });
  writeFileSync(join(outputDir, 'signal-map.json'), JSON.stringify(signalMap, null, 2));
  const coverage = mapCoverage(signalMap, instanceMap);
  console.log(`Signal map written: ${join(outputDir, 'signal-map.json')}`);
  console.log(`Coverage: ${coverage.activityTypesMapped}/${coverage.activityTypesTotal} activity types (${coverage.coveragePct}%), avg confidence ${coverage.avgConfidence}.`);
  if (signalMap.unmapped.length) {
    console.log(`\nUNMAPPED (review these — high-volume types here mean lost signal):`);
    for (const u of signalMap.unmapped) console.log(`  - [${u.id}] ${u.name}: ${u.description || 'no description'}`);
  }
  if (coverage.lowConfidence.length) {
    console.log(`\nLow-confidence mappings (verify or hand-edit signal-map.json):`);
    for (const m of coverage.lowConfidence) console.log(`  - [${m.id}] ${m.name} -> ${m.canonical} (${m.confidence})`);
  }
  console.log(`\nReview/edit signal-map.json, then: \`mse test --email someone@example.com\`.`);
}

async function cmdTestOrSnapshot(config, flags, { verbose }) {
  if (!flags.email && !flags.domain) {
    console.error('Usage: mse snapshot --email a@b.com   (or --domain b.com)');
    process.exit(1);
  }
  const client = makeClient(config);
  const outputDir = ensureOutputDir();
  const signalMap = loadJson(join(outputDir, 'signal-map.json'), 'signal map');
  const now = nowFor(config);

  // Domain-only snapshots: Marketo has no domain→leads filter, so resolve the
  // account's lead IDs from harvest state (populated by `mse harvest`).
  let seedLeadIds;
  if (flags.domain && !flags.email) {
    const state = loadState(outputDir);
    seedLeadIds = state.eventCache?.[flags.domain]?.leadIds || state.patternState?.[flags.domain]?.knownLeadIds;
    if (!seedLeadIds?.length) {
      console.error(
        `No harvest history for ${flags.domain} yet — \`--domain\` resolves leads from harvest state.\n` +
          `Either run \`mse harvest --once\` first (and let it see activity from this account),\n` +
          `or seed the account with one known address: mse snapshot --domain ${flags.domain} --email anyone@${flags.domain}`,
      );
      process.exit(1);
    }
  }

  const result = await runSnapshotPipeline(client, signalMap, {
    email: flags.email,
    domain: flags.domain,
    seedLeadIds,
    lookbackDays: Number(flags.lookback || config.lookbackDays),
    now,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (verbose) {
    console.log('── STAGE: lead resolution ──');
    console.log(`focus: ${result.focus.email} (${result.focus.id}); account leads: ${result.accountJourney.members.map((m) => m.email).join(', ')}`);
    console.log('\n── STAGE: normalized journey (focus lead) ──');
    for (const e of result.focusJourney.events) {
      console.log(`  ${e.ts}  ${e.canonicalType.padEnd(18)} ${e.asset || e.url || ''}${e.formIntent ? ` [${e.formIntent}]` : ''}`);
    }
    console.log('\n── STAGE: interpretation ──');
    console.log(JSON.stringify(result.interpretation, null, 2));
    console.log('\n── STAGE: snapshot ──');
  }

  console.log(result.snapshot.markdown);

  if (llmAvailable(config)) {
    console.error('Generating Claude narrative pass...');
    const narrative = await generateNarrativeSnapshot(config, {
      deterministicBrief: result.snapshot.markdown,
      journeyJson: result.snapshot.json,
    });
    if (narrative) {
      result.snapshot.json.narrative = narrative;
      console.log('\n---\n\n## Narrative brief (Claude)\n');
      console.log(narrative);
    }
  }

  const slug = (flags.email || flags.domain).replace(/[^a-z0-9.@-]/gi, '_');
  const mdPath = join(outputDir, 'snapshots', `${slug}.md`);
  const jsonPath = join(outputDir, 'snapshots', `${slug}.json`);
  writeFileSync(mdPath, result.snapshot.markdown + (result.snapshot.json.narrative ? `\n---\n\n## Narrative brief (Claude)\n\n${result.snapshot.json.narrative}\n` : ''));
  writeFileSync(jsonPath, JSON.stringify(result.snapshot.json, null, 2));
  console.error(`\nSaved: ${mdPath} + .json`);
}

async function cmdHarvest(config, flags) {
  const client = makeClient(config);
  const outputDir = ensureOutputDir();
  const signalMap = loadJson(join(outputDir, 'signal-map.json'), 'signal map');
  const sinks = buildSinks(config);
  console.error(`Sinks: ${sinks.map((s) => s.name).join(', ')}${sinks.length === 1 ? ' (set WRANGLER_URL/WRANGLER_API_KEY or SINK_WEBHOOK_URL for more)' : ''}`);

  if (flags['replay-failed']) {
    const { replayed, remaining } = await replayFailedDeliveries(outputDir, sinks, {
      log: (msg) => console.error(`[replay] ${msg}`),
    });
    console.log(`Replayed ${replayed} signal(s); ${remaining} still failing.`);
    if (remaining) process.exit(1);
    return;
  }

  const harvestOptions = {
    initialLookbackDays: config.initialLookbackDays,
    journeyLookbackDays: config.lookbackDays,
    dailyApiBudget: config.dailyApiBudget,
    emittedKeysCap: config.emittedKeysCap,
  };

  if (flags.daemon) {
    await harvestDaemon(client, signalMap, {
      outputDir,
      sinks,
      intervalMs: parseInterval(flags.interval, config.harvestIntervalMs),
      nowFn: () => nowFor(config),
      harvestOptions,
    });
    return;
  }

  const lock = acquireLock(outputDir);
  if (!lock) {
    console.error(`Another harvest is already running against ${outputDir} (.state.lock) — exiting without touching state.`);
    process.exit(1);
  }
  try {
    const state = loadState(outputDir);
    const result = await harvestOnce(client, signalMap, {
      state,
      sinks,
      now: nowFor(config),
      log: (msg) => console.error(`[harvest] ${msg}`),
      ...harvestOptions,
    });
    saveState(outputDir, result.state);
    const deadLettered = appendFailedDeliveries(outputDir, result.failedDeliveries);
    console.log(`Emitted ${result.emitted} signal(s). API calls today: ${result.apiCallsUsedToday ?? 'n/a'}/${config.dailyApiBudget}.`);
    for (const s of result.signals) console.log(`  [${s.signalType}] ${s.summary}`);
    for (const r of result.sinkResults) console.log(`  sink ${r.sink}: ${r.ok ? 'ok' : `FAILED ${r.error || r.status || ''}`}`);
    if (deadLettered) {
      console.error(`${deadLettered} signal(s) dead-lettered to ${join(outputDir, 'signals-failed.jsonl')} — run \`mse harvest --replay-failed\` once the sink recovers.`);
    }
  } finally {
    lock.release();
  }
}

async function cmdExplain(config) {
  const outputDir = ensureOutputDir();
  const instanceMap = loadJson(join(outputDir, 'marketo-instance-map.json'), 'instance map');
  const signalMapPath = join(outputDir, 'signal-map.json');
  const signalMap = existsSync(signalMapPath) ? JSON.parse(readFileSync(signalMapPath, 'utf8')) : null;

  console.log('# Marketo Signal Engine — findings report\n');
  console.log('## What the engine found\n');
  console.log(`- Instance inventory: ${JSON.stringify(instanceMap.counts)}`);
  console.log(`- Custom activity types: ${instanceMap.activityTypes.filter((t) => t.custom).map((t) => `${t.name} (${t.id})`).join(', ') || 'none'}`);
  console.log(`- Data-quality issues: ${instanceMap.dataQualityIssues.length}`);
  for (const i of instanceMap.dataQualityIssues) console.log(`  - [${i.kind}] ${i.subject}`);

  if (signalMap) {
    const coverage = mapCoverage(signalMap, instanceMap);
    console.log(`\n## Mapping confidence\n`);
    console.log(`- Coverage: ${coverage.activityTypesMapped}/${coverage.activityTypesTotal} activity types (${coverage.coveragePct}%), avg confidence ${coverage.avgConfidence}`);
    console.log(`- Unmapped: ${coverage.unmappedCount}; low-confidence: ${coverage.lowConfidence.length}`);
    const state = loadState(outputDir);
    console.log(`\n## Harvest state\n`);
    console.log(`- Last run: ${state.lastRunAt || 'never'}; signals emitted (lifetime keys tracked): ${state.emittedKeys.length}; accounts watched: ${Object.keys(state.patternState || {}).length}`);
    if (state.drift) {
      console.log(`\n## Drift detected (${state.drift.detectedAt})\n`);
      console.log(`The instance changed after mapping — re-run \`mse map\` and review signal-map.json to make these permanent:`);
      for (const t of state.drift.newActivityTypes) {
        console.log(`- New activity type [${t.id}] ${t.name}: ${t.hotAdded ? `hot-mapped to ${t.canonical} (${t.confidence})` : 'UNMAPPED — invisible until mapped'}`);
      }
      for (const f of state.drift.newForms) {
        console.log(`- New form "${f.name}": ${f.hotAdded ? `intent ${f.signalType} (${f.confidence})` : `generic form_fill (${f.confidence})`}`);
      }
    }
  } else {
    console.log('\nNo signal map yet — run `mse map`.');
  }

  console.log(`\n## Recommended next actions\n`);
  const recs = [];
  if (!signalMap) recs.push('Run `mse map`, review signal-map.json with your marketing ops owner.');
  if (signalMap?.unmapped?.length) recs.push(`Map the ${signalMap.unmapped.length} unmapped custom activity type(s) — each may carry commercial signal (or mark them "ignore").`);
  if (loadState(outputDir).drift) recs.push('Drift detected (see above): the instance grew new activity types/forms after mapping — re-run `mse map` and re-review signal-map.json.');
  if (instanceMap.dataQualityIssues.some((i) => i.kind === 'duplicate-looking-fields')) recs.push('Consolidate duplicate-looking lead fields before trusting field-based signals (MQL detection reads lifecycle fields).');
  recs.push('Engineering: run `mse harvest --daemon` on a box with outbound HTTPS (cron/systemd snippet in RUNBOOK.md).');
  recs.push('GTM: wire snapshots into the inbound SLA — generate `mse snapshot --email <lead>` on every contact-sales submission.');
  recs.push('GTM: review the first week of signals.jsonl with sellers — tune thresholds in signal-map.json (scoreJumpMin, stallGapDays, binge/surge windows).');
  for (const r of recs) console.log(`- ${r}`);
}

async function cmdPurge(config, flags) {
  const outputDir = ensureOutputDir();
  const olderThanDays = Number(flags['older-than'] || DEFAULT_PURGE_DAYS);
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    console.error('--older-than must be a positive number of days.');
    process.exit(1);
  }
  const report = purgeOutputs(outputDir, { olderThanDays, now: nowFor(config) });
  console.log(`Purged artifacts older than ${olderThanDays} day(s) (before ${report.cutoffIso}):`);
  console.log(`  signals.jsonl:        dropped ${report.signals.dropped}, kept ${report.signals.kept}`);
  console.log(`  signals-failed.jsonl: dropped ${report.deadLetter.dropped}, kept ${report.deadLetter.kept}`);
  console.log(`  snapshots/:           deleted ${report.snapshots.dropped}, kept ${report.snapshots.kept}`);
  console.log(`  state event cache:    ${report.eventCacheDomains} domain(s) (self-bounding — pruned by the harvester, not purge)`);
}

/* ── main ── */

const { command, flags } = parseArgs(process.argv.slice(2));
const config = loadConfig({ mock: flags.mock === true });

const commands = {
  auth: () => cmdAuth(config),
  recon: () => cmdRecon(config),
  map: () => cmdMap(config, flags),
  test: () => cmdTestOrSnapshot(config, flags, { verbose: true }),
  snapshot: () => cmdTestOrSnapshot(config, flags, { verbose: false }),
  harvest: () => cmdHarvest(config, flags),
  explain: () => cmdExplain(config),
  purge: () => cmdPurge(config, flags),
};

if (!command || !commands[command]) {
  console.error('Usage: mse <auth|recon|map|test|snapshot|harvest|explain|purge> [flags]\n');
  console.error('Autopilot order: auth -> recon -> map -> test -> snapshot -> harvest -> explain');
  console.error('Demo without credentials: add --mock (or MSE_MOCK=1) to any command.');
  process.exit(command ? 1 : 0);
}

if (!['explain', 'purge'].includes(command)) requireMarketoCreds(config);

commands[command]().catch((err) => {
  console.error(`${command} failed: ${err.message}`);
  if (process.env.MSE_DEBUG) console.error(err.stack);
  process.exit(1);
});
