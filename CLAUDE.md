# CLAUDE.md — Marketo Auto Recon (Marketo Signal Engine)

You are an agent (Claude Code, Cursor, or similar) pointed at this folder. Your job is to
**drive the autopilot** against the operator's Marketo instance: run the stages in order,
interpret the outputs, get the human to review the one artifact that needs judgment
(`signal-map.json`), and leave them with snapshots + a running harvester.

## What this tool is

A standalone, zero-dependency, read-only Node CLI that turns any Marketo instance into:
1. an instance map (what exists in there),
2. an editable signal taxonomy (`signal-map.json`),
3. normalized chronological buyer journeys per lead + account,
4. 9-section seller snapshots,
5. a continuous stream of deduped state-change signals to jsonl/webhook/Wrangler sinks.

Read [README.md](README.md) for the stage catalog and [RUNBOOK.md](RUNBOOK.md) for the
deployment phases + acceptance checklist. Everything below is agent-operational.

## The autopilot sequence (run these, in order)

```bash
node bin/mse.js auth                     # stop here if this fails; see RUNBOOK Phase 0-1
node bin/mse.js recon                    # then READ outputs/marketo-instance-map.md
node bin/mse.js map                      # then READ outputs/signal-map.json
node bin/mse.js test --email <real lead> # verify the pipeline on a lead the operator names
node bin/mse.js snapshot --email <lead>  # show the operator the brief
node bin/mse.js harvest --once           # verify signals; run twice to prove dedupe (2nd run = 0)
node bin/mse.js explain                  # summarize findings for the operator
```

No credentials yet? Demo everything with `--mock` (or `npm run demo`) so the operator sees
the end state before doing Marketo admin work.

## Rules for the agent

1. **Never edit files under `src/` to fix a mapping problem — edit `outputs/signal-map.json`.**
   The map is the configuration surface: activity-type mappings, form intents, URL patterns,
   thresholds. Code changes are for bugs only.
2. **Always get a human to review `signal-map.json`** before starting the harvester. Walk
   them through: the `unmapped` list (lost signal), low-confidence mappings, form intents,
   and URL patterns. This is the one judgment step in the pipeline.
3. **This tool is read-only against Marketo.** Do not add write calls. If the operator asks
   for Marketo writes, that is out of scope by design (PRD 181 non-goal).
4. **Do not commit `outputs/` or `.env`** — both are gitignored; keep it that way. Outputs
   contain lead PII.
5. **Interpret, don't just dump.** After `recon`, tell the operator the 3–5 most important
   findings (custom activity types with volume, DQ issues, suspicious fields). After
   `harvest`, summarize which signal types fired and for which accounts.
6. **When a stage errors,** check the Troubleshooting table in RUNBOOK.md first; most
   failures are role/permission issues on the Marketo side, not code.
7. **Run `npm test` after any code change.** The suite covers client auth/retry, recon,
   mapping, normalization, interpretation, snapshots, harvesting, dedupe, and sink contracts.

## Code map (for when you do need to change code)

| File | Owns |
|---|---|
| `bin/mse.js` | CLI dispatch, flags, output writing |
| `src/config.js` | `.env` loading, defaults, interval parsing |
| `src/marketo-client.js` | OAuth, rate limit (90/20s), retries, paging, GET-only surface |
| `src/mock-transport.js` + `fixtures/instance.js` | Synthetic instance for `--mock` and tests |
| `src/recon.js` | Inventory + field categorization + DQ audit + markdown render |
| `src/signal-map.js` | Heuristic classifiers, canonical taxonomy, coverage stats |
| `src/llm.js` | Optional Anthropic calls (mapping assist, narrative brief) — no-op without key |
| `src/normalizer.js` | Raw activities → canonical events; lead journey; account rollup; topics |
| `src/interpreter.js` | Journey stage, stalls, velocity, event + pattern signals, dedupe keys |
| `src/snapshot.js` | The 9-section deterministic seller brief |
| `src/pipeline.js` | Lead/account resolution + full pipeline orchestration |
| `src/harvester.js` | Incremental polling, state persistence, dedupe, sink fan-out, daemon |
| `src/sinks/` | `jsonl.js`, `webhook.js` (HMAC), `wrangler.js` (ingest-batch adapter) |

## Wrangler integration (when running inside the Wrangler repo)

Set `WRANGLER_URL` + `WRANGLER_API_KEY` in `.env`. Harvested signals post to
`POST /signals/ingest-batch` and flow through `storeSignal` → account `signals[]` →
`triggerLoopsForSignal` (PRD 179) → Signal Execution daily plays (PRD 180). Skipped rows
mean the domain isn't a named account — expected. Connector doc: `docs/connectors/MARKETO.md`
in the Wrangler repo.
