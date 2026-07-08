# FAQ

## Safety and access

**Can this break my Marketo instance?**
No. Every Marketo REST call the client makes is a GET, and a test fails the suite if any other
method is ever issued against a REST endpoint. The single exception is the OAuth handshake —
one POST of the client credentials to Marketo's identity endpoint (that's authentication, not
a write, and it keeps the secret out of URLs and access logs). There is no code path that can
create, update, or delete anything. Still, follow the [RUNBOOK](RUNBOOK.md) and use an API
user with a read-only role, so the same property is enforced on Marketo's side too.

**What Marketo permissions does it need?**
A LaunchPoint Custom Service attached to an API-only user with read access to leads,
activities, and assets. No write scopes. Setup steps are in the [RUNBOOK](RUNBOOK.md).

**Will it eat my API quota?**
It rate-limits itself to 90 calls per 20 seconds (under Marketo's 100/20s cap) and uses
incremental paging tokens, so it only ever pulls new activity. Account history is pulled once
per lead and then maintained in a rolling per-account event cache, so later polls append
rather than re-pull. Recon is a one-time ~30 calls; a 15-minute harvest cadence on a mid-size
instance is a few hundred calls/day against a default daily quota of 50,000. As a backstop,
the harvester keeps a daily API-call counter and stops making history pulls past
`MSE_DAILY_API_BUDGET` (default 10,000) — event signals keep flowing, and the breach is
logged loudly.

**Where does the data go?**
Local files in `outputs/` (gitignored), plus whatever sinks you explicitly configure. There is
no telemetry, no phone-home, and no third-party service in the loop. If you set
`ANTHROPIC_API_KEY`, snapshot/mapping text is sent to Anthropic's API — leave it unset and
nothing leaves your machine except the Marketo API calls themselves.

**What about PII?**
The tool processes lead emails and activity history — treat `outputs/` with the same care as a
CRM export. Nothing is stored anywhere you didn't point a sink at. The directory is created
owner-only (`0700`), you can relocate all local artifacts (maps, snapshots, signals, state)
with `MSE_OUTPUT_DIR`, and `mse purge --older-than 90` enforces a retention window (drops old
signals, dead-letter rows, and snapshots — see the RUNBOOK's data-retention section).

**Does the LLM option send lead data to Anthropic?**
Yes — the narrative-snapshot path ships journey data (names, emails, activity history) to
Anthropic's API. Review this with your legal/privacy team before enabling it in production.
Set `MSE_LLM_REDACT=1` to pseudonymize emails and surnames before anything is sent (first
names and company domains are kept so the brief still reads). Note the redaction's limits:
free-text form comments (whatever a lead typed into a "Comments" box) and company names are
NOT redacted — if those matter to your privacy posture, leave the LLM path off. The
deterministic pipeline never needs the key at all.

Also be aware the narrative layer consumes **untrusted input**: form comments are typed by
whoever filled your public forms. Mitigations are in place — free-text fields are truncated
to 200 characters before anything reaches the prompt, and the model is instructed to treat
lead-submitted text as data, never as directives — but as with any LLM summarizing
user-supplied text, a rep should treat the narrative brief as a draft, not gospel. The
deterministic brief quotes the same text with the same cap and no model in the loop.

## Running it

**I don't have Marketo credentials yet. Can I still evaluate it?**
Yes — that's the point of mock mode. `npm run demo` (or `--mock` on any command) runs the full
pipeline against a bundled synthetic instance. The [examples/](examples/) folder contains the
committed output so you can read it without running anything.

**Do I need an LLM API key?**
No. Everything — recon, mapping, journeys, snapshots, harvesting — is deterministic code.
`ANTHROPIC_API_KEY` optionally adds a Claude-written narrative on top of the deterministic
snapshot and suggestions for ambiguous custom-field mappings. The LLM is never load-bearing.

**Node version?**
Node ≥ 18 (native `fetch`). No npm install needed — there are zero dependencies.

**How long does a full run take?**
Recon: a couple of minutes on most instances. A single snapshot: under 5 seconds after the
lead's activity is pulled. Harvest: proportional to new activity since the last poll.

## The mapping

**The classifier got something wrong. Do I fix the code?**
No — fix `outputs/signal-map.json`. The map is the contract; the code just executes it.
Heuristics only produce the *first draft* with confidence and rationale per row; a human
review pass is an expected step (see [PLAN.md](PLAN.md) Phase 2), not a failure mode.

**What happens to activity types it can't classify?**
They're listed under `unmapped` in the signal map and reported by `mse explain` — flagged,
never silently dropped and never guessed.

**What about activity types or forms created AFTER I ran `mse map`?**
The harvester checks for them once a day (drift detection, 2 API calls): new items are
logged loudly, hot-mapped for the current run when the heuristics are confident, and shown
in `mse explain` under "Drift detected". Your hand-edited `signal-map.json` is never
rewritten automatically — re-run `mse map` and re-review to make the additions permanent.

**Our funnel thresholds are different (score jumps, stall windows, binge counts).**
All thresholds live in `signal-map.json` and are meant to be tuned per instance.

## Integrating

**How do I get signals into my CRM / Slack / agent pipeline?**
Three built-in sinks: a local JSONL file (always on), a generic webhook with optional HMAC
signing, and the Wrangler ingest-batch adapter. Writing your own sink is one function — see
"Build on top of it" in [PLAN.md](PLAN.md) and `src/sinks/webhook.js` as the template.

**What happens if my webhook / downstream system is down during a poll?**
Nothing is lost. Signals whose delivery failed are written to
`outputs/signals-failed.jsonl`; run `mse harvest --replay-failed` once the sink recovers and
they're re-sent (rows that succeed are removed, still-failing rows are kept). The local
`signals.jsonl` always has everything regardless.

**Will duplicate signals fire every poll?**
No. Every signal has a `dedupeKey`, and emitted keys plus Marketo paging tokens persist in
`outputs/.state.json` — restarts and re-polls don't re-emit. The dedupe set keeps the most
recent 50,000 keys (`MSE_EMITTED_KEYS_CAP`); on very high-volume instances the oldest keys
eventually evict, so a months-old signal could in principle re-fire — raise the cap if that
matters to you. A `.state.lock` file prevents two harvesters (say, a cron job and a daemon)
from clobbering each other's state.

**The default Claude model looks old.**
Set `ANTHROPIC_MODEL` in `.env` — model names age faster than this README. The default is
only a fallback.

**Can it watch multiple Marketo instances?**
Run one clone per instance, each with its own `.env`. State, maps, and outputs live inside
the folder by design, so clones never interfere with each other.

**We use HubSpot / Pardot / Eloqua, not Marketo.**
The Marketo-specific part is just the client + recon layer. The normalizer, interpreter,
snapshot, and harvester operate on a canonical event schema — see the porting note in
[PLAN.md](PLAN.md) Phase 5.
