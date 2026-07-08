# Marketo Auto Recon — technical reference

Companion to the [README](README.md). Everything here is produced by the `mse` CLI.

## What each stage produces

| Stage | Command | Output |
|---|---|---|
| Recon | `mse recon` | `outputs/marketo-instance-map.md` + `.json` — activity types (incl. custom), lead fields by category (scoring/lifecycle/UTM/attribution/suspect), programs, smart campaigns, forms, landing pages, emails, and a data-quality audit (duplicate-looking fields, dead campaigns, deprecated custom activities) |
| Map | `mse map [--llm]` | `outputs/signal-map.json` — every activity type and form classified into the canonical taxonomy with **confidence and rationale per mapping**. Unmapped types are flagged, never silently dropped. Hand-edit this file; it is the contract for everything downstream. |
| Test | `mse test --email x@y.com` | Stage-by-stage dump for one lead: resolution → normalized journey → interpretation → snapshot. Proves the map before you scale. |
| Snapshot | `mse snapshot --email x@y.com` | 9-section seller brief (markdown + JSON): who / what they care about / why you should want this / doubts / what to say / channel + timing / next step / follow-up plan / who else is involved. Deterministic in <5s; Claude narrative pass when `ANTHROPIC_API_KEY` is set. |
| Harvest | `mse harvest [--once\|--daemon]` | Canonical signals to sinks. Incremental (Marketo paging tokens persisted in `outputs/.state.json`), deduped across runs and restarts. |
| Explain | `mse explain` | Human report: inventory, mapping coverage %, confidence, DQ issues, harvest state, recommended engineering + GTM next actions. |

## The journey blob (normalized schema)

Per lead: identity + role guess (executive/manager/practitioner, ATL/BTL lane), chronological
`events[]` (`ts`, `canonicalType`, `rawTypeName`, `asset`, `url`, `urlCategory`, `formIntent`,
`scoreDelta`), derived `journeyStage` (awareness → consideration → decision → customer),
`stalls[]` (gaps, score drops, repeat-without-progress), `topics[]`, `velocity`
(rising/steady/falling/dormant). Per account: members, committee shape (size, active count,
ATL/BTL split), combined timeline, who else is active.

## Signals emitted

`form_fill` · `demo_request` · `contact_us` · `pricing_page_visit` · `competitor_research` ·
`mql` · `product_signup` · `score_jump` · `content_binge` · `intent_surge` · `journey_stall` ·
`reactivation` · `committee_growth`

Every signal carries: `dedupeKey`, `domain`, `leadId`, `email`, `timestamp`, `strength`
(0–100), a human-readable `summary`, and `evidence` (the raw Marketo activity IDs behind it).
Thresholds (score-jump size, binge/surge windows, stall gap) live in `signal-map.json` and
are meant to be tuned.

## Sinks

| Sink | Enabled by | Behavior |
|---|---|---|
| `jsonl` | always | Appends to `outputs/signals.jsonl` |
| `webhook` | `SINK_WEBHOOK_URL` | POSTs `{ source, signals[] }`; HMAC-SHA256 `x-mse-signature` header when `SINK_WEBHOOK_SECRET` set |
| `wrangler` | `WRANGLER_URL` + `WRANGLER_API_KEY` | Adapts signals to Wrangler's `POST /signals/ingest-batch` rows — they flow into the signal spine, Loop Engine, and daily plays automatically |

## Code map

| Module | Role |
|---|---|
| `bin/mse.js` | CLI dispatcher |
| `src/marketo-client.js` | REST client: OAuth, rate limiting (90 calls/20s), retries, paging. GET-only. |
| `src/recon.js` | Inventory + data-quality audit |
| `src/signal-map.js` | Heuristic classifier → editable `signal-map.json` |
| `src/normalizer.js` | Raw activities → canonical chronological journeys |
| `src/interpreter.js` | Stage, stalls, velocity, event + pattern signal extraction |
| `src/snapshot.js` | 9-section seller brief |
| `src/harvester.js` | Incremental polling daemon, state persistence, dedupe, sink fan-out |
| `src/sinks/` | jsonl, webhook (HMAC), wrangler ingest-batch |
| `src/mock-transport.js` + `fixtures/` | Full synthetic instance for `--mock` mode |

## PRD

When used inside the Wrangler repo, the full PRD lives at `docs/prds/MARKETO_SIGNAL_ENGINE.md`
(PRD 181).
