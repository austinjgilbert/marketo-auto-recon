# FAQ

## Safety and access

**Can this break my Marketo instance?**
No. The client is physically incapable of writing — every request goes through one function
that only issues GET requests, and a test (`client only ever issues GET requests`) fails the
suite if that ever changes. Still, follow the [RUNBOOK](RUNBOOK.md) and use an API user with a
read-only role, so the guarantee is enforced on Marketo's side too.

**What Marketo permissions does it need?**
A LaunchPoint Custom Service attached to an API-only user with read access to leads,
activities, and assets. No write scopes. Setup steps are in the [RUNBOOK](RUNBOOK.md).

**Will it eat my API quota?**
It rate-limits itself to 90 calls per 20 seconds (under Marketo's 100/20s cap) and uses
incremental paging tokens, so it only ever pulls new activity. Recon is a one-time ~30 calls;
a 15-minute harvest cadence on a mid-size instance is a few hundred calls/day against a
default daily quota of 50,000.

**Where does the data go?**
Local files in `outputs/` (gitignored), plus whatever sinks you explicitly configure. There is
no telemetry, no phone-home, and no third-party service in the loop. If you set
`ANTHROPIC_API_KEY`, snapshot/mapping text is sent to Anthropic's API — leave it unset and
nothing leaves your machine except the Marketo API calls themselves.

**What about PII?**
The tool processes lead emails and activity history — treat `outputs/` with the same care as a
CRM export. Nothing is stored anywhere you didn't point a sink at.

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

**Our funnel thresholds are different (score jumps, stall windows, binge counts).**
All thresholds live in `signal-map.json` and are meant to be tuned per instance.

## Integrating

**How do I get signals into my CRM / Slack / agent pipeline?**
Three built-in sinks: a local JSONL file (always on), a generic webhook with optional HMAC
signing, and the Wrangler ingest-batch adapter. Writing your own sink is one function — see
"Build on top of it" in [PLAN.md](PLAN.md) and `src/sinks/webhook.js` as the template.

**Will duplicate signals fire every poll?**
No. Every signal has a `dedupeKey`, and emitted keys plus Marketo paging tokens persist in
`outputs/.state.json` — restarts and re-polls don't re-emit.

**Can it watch multiple Marketo instances?**
Run one clone per instance, each with its own `.env`. State, maps, and outputs live inside
the folder by design, so clones never interfere with each other.

**We use HubSpot / Pardot / Eloqua, not Marketo.**
The Marketo-specific part is just the client + recon layer. The normalizer, interpreter,
snapshot, and harvester operate on a canonical event schema — see the porting note in
[PLAN.md](PLAN.md) Phase 5.
