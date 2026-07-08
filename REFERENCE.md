# Marketo Auto Recon — technical reference

Companion to the [README](README.md). Everything here is produced by the `mse` CLI.

## What each stage produces

| Stage | Command | Output |
|---|---|---|
| Recon | `mse recon` | `outputs/marketo-instance-map.md` + `.json` — activity types (incl. custom), lead fields by category (scoring/lifecycle/UTM/attribution/suspect), programs, smart campaigns, forms, landing pages, emails, and a data-quality audit (duplicate-looking fields, dead campaigns, deprecated custom activities) |
| Map | `mse map [--llm]` | `outputs/signal-map.json` — every activity type and form classified into the canonical taxonomy with **confidence and rationale per mapping**. Unmapped types are flagged, never silently dropped. Hand-edit this file; it is the contract for everything downstream. |
| Test | `mse test --email x@y.com` | Stage-by-stage dump for one lead: resolution → normalized journey → interpretation → snapshot. Proves the map before you scale. |
| Snapshot | `mse snapshot --email x@y.com` | 9-section seller brief (markdown + JSON): who / what they care about / why you should want this / doubts / what to say / channel + timing / next step / follow-up plan / who else is involved. Deterministic in <5s; Claude narrative pass when `ANTHROPIC_API_KEY` is set. |
| Harvest | `mse harvest [--once\|--daemon]` | Canonical signals to sinks. Incremental (per-chunk Marketo paging tokens persisted in `outputs/.state.json`), deduped across runs and restarts, protected by a `.state.lock` against concurrent harvesters, budget-guarded (`MSE_DAILY_API_BUDGET`), with a rolling per-account event cache so account history is pulled once, not every poll. |
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
| `webhook` | `SINK_WEBHOOK_URL` | POSTs `{ source, signals[] }`; signed when `SINK_WEBHOOK_SECRET` set (see below) |
| `wrangler` | `WRANGLER_URL` + `WRANGLER_API_KEY` | Adapts signals to Wrangler's `POST /signals/ingest-batch` rows — they flow into the signal spine, Loop Engine, and daily plays automatically |

### Webhook signature verification (receiver side)

When `SINK_WEBHOOK_SECRET` is set, every request carries two headers:

- `x-mse-timestamp` — Unix epoch milliseconds at send time
- `x-mse-signature` — hex HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` with the shared secret

Verify both, or a captured request can be replayed later:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_MS = 5 * 60_000; // reject anything older than 5 minutes

function verify(req, rawBody, secret) {
  const timestamp = req.headers['x-mse-timestamp'];
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > TOLERANCE_MS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const got = Buffer.from(req.headers['x-mse-signature'] || '', 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
```

## Code map

| Module | Role |
|---|---|
| `bin/mse.js` | CLI dispatcher |
| `src/marketo-client.js` | REST client: OAuth (POST body, secret never in URLs), rate limiting (90 calls/20s), retries with timeouts, paging with progress guards, lead-ID/type-ID chunking. GET-only against REST endpoints. |
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
