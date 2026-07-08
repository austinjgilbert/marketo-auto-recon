# Marketo Auto Recon — adoption plan

*How to go from "someone sent me this repo" to a production signal feed, and how to build on
top of it. Each phase has a clear exit criterion; stop at whichever phase gives you what you
need.*

## Phase 0 — Prove the concept to yourself (15 minutes, no Marketo)

```bash
git clone https://github.com/austinjgilbert/marketo-auto-recon.git && cd marketo-auto-recon
npm test        # 46 tests, all offline
npm run demo    # full pipeline against the bundled synthetic instance
```

Read what came out:

- `outputs/marketo-instance-map.md` — what recon produces
- `outputs/signal-map.json` — the mapping contract you'll be editing
- `outputs/snapshots/*.md` — the seller brief format
- `outputs/signals.jsonl` — the harvested signal format

**Exit criterion:** you can explain to a colleague what each of the five stages does.

> Working with a coding agent (Claude Code / Cursor)? Point it at [CLAUDE.md](CLAUDE.md) and it
> will drive every phase below for you.

## Phase 1 — Recon a real instance (an afternoon)

1. Have a Marketo admin create a **read-only API user** and Custom Service
   ([RUNBOOK.md](RUNBOOK.md) has the exact steps and scopes).
2. `cp .env.example .env`, fill in the three `MARKETO_*` values.
3. `node bin/mse.js auth && node bin/mse.js recon && node bin/mse.js explain`

You now have the instance map: every activity type, field, form, and program, plus a
data-quality audit. This artifact alone is usually worth the afternoon — it's the document
nobody at the company has.

**Exit criterion:** `marketo-instance-map.md` reviewed with whoever owns Marketo; suspect
fields and dead campaigns confirmed or corrected.

## Phase 2 — Build and validate the signal map (1–2 days, mostly review)

1. `node bin/mse.js map` (add `--llm` if you have an `ANTHROPIC_API_KEY` for suggestions on
   ambiguous custom types).
2. Open `outputs/signal-map.json`. Review every mapping below ~0.8 confidence and everything
   under `unmapped`. Fix intents, URL categories, and thresholds for *your* funnel.
3. Pick 3–5 leads you personally know the history of and run
   `node bin/mse.js test --email <them>`. Does the journey match reality? Does the stage feel
   right? Tune the map, not the code.

**Exit criterion:** a seller or marketer reads a `mse snapshot` for a lead they know and says
"yes, that's what happened."

## Phase 3 — Snapshots in the workflow (first week)

Wire snapshots to the moment of need — pick one:

- **On hand-raise:** when a demo/contact form arrives, run
  `mse snapshot --email <lead>` and attach the markdown to the routing notification.
- **Pre-call:** run snapshots for tomorrow's meetings on a schedule.
- **On demand:** give SDRs a one-line alias or a Slack slash command that shells out to the CLI.

**Exit criterion:** a rep walks into a call having read a snapshot instead of an empty CRM page.

## Phase 4 — Continuous harvesting (second week)

```bash
node bin/mse.js harvest --daemon --interval 15m
```

Run it under systemd/launchd/a container — state persists in `outputs/.state.json`, so
restarts are safe and nothing double-fires. Choose sinks in `.env`:

- `signals.jsonl` — always on; good enough for a cron job that posts to Slack
- `SINK_WEBHOOK_URL` (+ optional HMAC secret) — feed any system you already have
- `WRANGLER_URL` + `WRANGLER_API_KEY` — signals flow straight into the Wrangler signal spine,
  Loop Engine, and daily plays

**Exit criterion:** a state-change signal (pricing visit, content binge, reactivation) reached
a human within 15 minutes of happening in Marketo, with evidence attached.

## Phase 5 — Build on top of it

The tool is deliberately a set of small composable modules (see the code map in
[REFERENCE.md](REFERENCE.md)). Natural extensions, roughly in order of leverage:

| Idea | Where to start |
|---|---|
| **New sink** (Salesforce task, HubSpot timeline, Slack DM, your agent framework) | Copy `src/sinks/webhook.js` — a sink is one function receiving `signals[]` |
| **New pattern signal** (e.g. "multiple stakeholders hit the same asset within 48h") | `src/interpreter.js` — pattern extractors take the journey blob and return signals with dedupe keys |
| **New snapshot section or a different brief format** (exec summary, QBR pack) | `src/snapshot.js` — sections are independent builders over the interpreted journey |
| **Account-level daemon** (watch a named account list instead of the whole instance) | `src/harvester.js` — filter at the lead-resolution step |
| **Another marketing platform** (HubSpot, Pardot, Eloqua) | Keep everything from `src/normalizer.js` down; replace `src/marketo-client.js` + `src/recon.js` with the new API. The canonical event schema is the interface. |
| **Marketo Bulk Extract for backfills** | For very large instances, the REST activity API is the wrong tool for initial history loads — Marketo's Bulk Extract API (async CSV jobs, separate 500MB/day quota) would let the first pull cover months cheaply. The harvester's event cache is the natural insertion point: bulk-load it once, then let incremental polling maintain it. |
| **A UI** over instance maps and snapshots | Everything is already JSON in `outputs/` — render it |

Rules for extending without breaking the concept:

1. **Never add a write path to the source platform.** Read-only is the trust contract.
2. **New signal types must carry evidence and a dedupe key.** No unexplainable alerts.
3. **Keep the mapping human-editable.** If your feature needs config, put it in
   `signal-map.json`, not code.
4. **Keep the core dependency-free.** Sinks may talk to anything; the engine stays `git clone
   && node`.

## Sharing this with someone

Send them the repo link and one line:

> Clone https://github.com/austinjgilbert/marketo-auto-recon and run `npm run demo`, then read
> `PRODUCT.md` — you'll get the whole idea in 15 minutes, and `PLAN.md` takes you from there
> to production.
