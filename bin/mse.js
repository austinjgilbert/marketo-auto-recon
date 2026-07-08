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
 *   mse explain                      what the engine found + recommended next actions
 *
 * Global flags: --mock (or MSE_MOCK=1) runs against the bundled fixture instance.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ensureOutputDir, requireMarketoCreds, parseInterval } from '../src/config.js';
import { MarketoClient } from '../src/marketo-client.js';
import { createMockTransport } from '../src/mock-transport.js';
import { runRecon, renderInstanceMapMarkdown } from '../src/recon.js';
import { buildSignalMap, mapCoverage } from '../src/signal-map.js';
import { runSnapshotPipeline } from '../src/pipeline.js';
import { harvestOnce, harvestDaemon, loadState, saveState } from '../src/harvester.js';
import { createJsonlSink } from '../src/sinks/jsonl.js';
import { createWebhookSink } from '../src/sinks/webhook.js';
import { createWranglerSink } from '../src/sinks/wrangler.js';
import { makeLlmMappingAssist, generateNarrativeSnapshot, llmAvailable } from '../src/llm.js';
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
    });
  }
  return new MarketoClient({
    baseUrl: config.marketo.baseUrl,
    clientId: config.marketo.clientId,
    clientSecret: config.marketo.clientSecret,
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
    sinks.push(createWebhookSink({ url: config.sinks.webhookUrl, secret: config.sinks.webhookSecret }));
  }
  if (config.sinks.wranglerUrl && config.sinks.wranglerApiKey) {
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
  const map = await runRecon(client);
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

  const result = await runSnapshotPipeline(client, signalMap, {
    email: flags.email,
    domain: flags.domain,
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

  if (flags.daemon) {
    await harvestDaemon(client, signalMap, {
      outputDir,
      sinks,
      intervalMs: parseInterval(flags.interval, config.harvestIntervalMs),
    });
    return;
  }

  const state = loadState(outputDir);
  const result = await harvestOnce(client, signalMap, {
    state,
    sinks,
    now: nowFor(config),
    log: (msg) => console.error(`[harvest] ${msg}`),
  });
  saveState(outputDir, result.state);
  console.log(`Emitted ${result.emitted} signal(s).`);
  for (const s of result.signals) console.log(`  [${s.signalType}] ${s.summary}`);
  for (const r of result.sinkResults) console.log(`  sink ${r.sink}: ${r.ok ? 'ok' : `FAILED ${r.error || r.status || ''}`}`);
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
  } else {
    console.log('\nNo signal map yet — run `mse map`.');
  }

  console.log(`\n## Recommended next actions\n`);
  const recs = [];
  if (!signalMap) recs.push('Run `mse map`, review signal-map.json with your marketing ops owner.');
  if (signalMap?.unmapped?.length) recs.push(`Map the ${signalMap.unmapped.length} unmapped custom activity type(s) — each may carry commercial signal (or mark them "ignore").`);
  if (instanceMap.dataQualityIssues.some((i) => i.kind === 'duplicate-looking-fields')) recs.push('Consolidate duplicate-looking lead fields before trusting field-based signals (MQL detection reads lifecycle fields).');
  recs.push('Engineering: run `mse harvest --daemon` on a box with outbound HTTPS (cron/systemd snippet in RUNBOOK.md).');
  recs.push('GTM: wire snapshots into the inbound SLA — generate `mse snapshot --email <lead>` on every contact-sales submission.');
  recs.push('GTM: review the first week of signals.jsonl with sellers — tune thresholds in signal-map.json (scoreJumpMin, stallGapDays, binge/surge windows).');
  for (const r of recs) console.log(`- ${r}`);
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
};

if (!command || !commands[command]) {
  console.error('Usage: mse <auth|recon|map|test|snapshot|harvest|explain> [flags]\n');
  console.error('Autopilot order: auth -> recon -> map -> test -> snapshot -> harvest -> explain');
  console.error('Demo without credentials: add --mock (or MSE_MOCK=1) to any command.');
  process.exit(command ? 1 : 0);
}

if (command !== 'explain') requireMarketoCreds(config);

commands[command]().catch((err) => {
  console.error(`${command} failed: ${err.message}`);
  if (process.env.MSE_DEBUG) console.error(err.stack);
  process.exit(1);
});
