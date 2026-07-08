# RUNBOOK — deploying Marketo Auto Recon (the Marketo Signal Engine)

For the engineer who has (or can get) Marketo access. Follow this top to bottom; each phase
has a verification step. Total hands-on time for phases 1–4 is under an hour; phase 5 runs
continuously.

---

## Phase 0 — What you need from Marketo admin

Ask your Marketo administrator for a **REST API custom service** with a **read-only API user**:

1. **Admin → Users & Roles → Roles → New Role.** Grant ONLY: `Access API` → `Read-Only Lead`,
   `Read-Only Activity`, `Read-Only Assets`, `Read-Only Campaign`. Name it e.g. `API Read-Only (Signal Engine)`.
2. **Admin → Users & Roles → Invite New User.** API-Only user (check "API Only"), assign the role above.
3. **Admin → Integration → LaunchPoint → New Service.** Type "Custom", tie it to the API-only user.
   Copy the **Client ID** and **Client Secret**.
4. **Admin → Integration → Web Services.** Copy the **REST API Endpoint**
   (`https://XXX-XXX-XXX.mktorest.com/rest`) — the base URL is that minus `/rest`.

The engine never writes to Marketo (every REST call is a GET by construction; the only POST
is the OAuth handshake to the identity endpoint), but the read-only role means nobody has to
take that on faith.

**API budget:** Marketo allows 50,000 REST calls/day and 100 calls/20s. The engine
rate-limits itself to 90/20s, keeps a rolling per-account event cache so history is pulled
once per lead (not every poll), and stops history pulls if a persisted daily counter passes
`MSE_DAILY_API_BUDGET` (default 10,000). A 15-minute harvest cadence on a mid-size instance
uses a few hundred calls/day; recon is a one-time ~30 calls.

## Phase 1 — Install and authenticate

```bash
git clone https://github.com/austinjgilbert/marketo-auto-recon.git && cd marketo-auto-recon
cp .env.example .env
# fill in MARKETO_BASE_URL, MARKETO_CLIENT_ID, MARKETO_CLIENT_SECRET
node bin/mse.js auth
```

**Verify:** prints "Authenticated against https://... API user can see N activity types."
If it fails: check the base URL has no trailing `/rest`, and that the LaunchPoint service is
approved.

## Phase 2 — Recon

```bash
node bin/mse.js recon
```

**Verify:** open `outputs/marketo-instance-map.md`. Sanity-check the counts against what the
Marketo UI shows (Admin → nothing needed — just eyeball forms/programs). Read the
**Data quality issues** section with your marketing-ops owner; it usually surfaces the
"nobody knows what this field does" candidates immediately.

## Phase 3 — Map, then REVIEW THE MAP

```bash
node bin/mse.js map          # heuristics only
node bin/mse.js map --llm    # optionally: Claude assists on ambiguous custom types
```

Open `outputs/signal-map.json` with whoever knows the instance best (30 minutes, once):

- **`activityTypes`** — is each custom type mapped sensibly? Anything in `unmapped` that has
  real volume is lost signal until you map it (or set `"canonical": "ignore"` deliberately).
- **`forms`** — do the intent classifications match reality? A form named "Get Started" might
  be your real demo-request form; set it to `demo_request`.
- **`urlPatterns`** — add your actual pricing/comparison/docs URL paths.
- **`thresholds`** — defaults: score jump ≥10, content binge 3 touches/72h, stall 21 days,
  intent surge 5 touches/24h. Tune after a week of real signals.

**Verify:** `node bin/mse.js test --email <a real recent inbound lead>` — read each stage's
output. The normalized journey should match what Marketo's activity log shows for that person.

## Phase 4 — Snapshots for sellers

```bash
node bin/mse.js snapshot --email <lead>
```

**Verify with a seller:** hand them the markdown and ask two questions — "could you act on
this in 20 seconds?" and "is anything wrong?" Wrong beats missing: fix the map, re-run.

Optional: set `ANTHROPIC_API_KEY` in `.env` for the narrative pass.

## Phase 5 — Continuous harvesting

Configure sinks in `.env` (any combination):

```
WRANGLER_URL=https://website-scanner.<your-subdomain>.workers.dev
WRANGLER_API_KEY=<MOLT_API_KEY>
SINK_WEBHOOK_URL=https://your-receiver.example.com/marketo-signals
SINK_WEBHOOK_SECRET=<shared secret>
```

Run once to validate, then daemonize:

```bash
node bin/mse.js harvest --once
node bin/mse.js harvest --daemon --interval 15m
```

**cron alternative** (state is persisted, so `--once` on a schedule is equivalent):

```cron
*/15 * * * * cd /path/to/marketo-auto-recon && node bin/mse.js harvest --once >> harvest.log 2>&1
```

**launchd (macOS):** create `~/Library/LaunchAgents/com.mse.harvest.plist` with
`ProgramArguments = [node, bin/mse.js, harvest, --once]`, `StartInterval = 900`,
`WorkingDirectory = <this folder>`.

Notes:
- First run only looks back `MSE_INITIAL_LOOKBACK_DAYS` (default 7, so a fresh install
  doesn't flood sinks with months of history). State lives in `outputs/.state.json`; delete
  it to re-baseline.
- A `.state.lock` file prevents a cron `--once` from colliding with a running daemon — the
  second process exits with a clear message instead of clobbering state. Stale locks
  (>15 min without refresh) are stolen automatically.
- Move all local artifacts (maps, snapshots, signals, state) with `MSE_OUTPUT_DIR` — useful
  for global installs, read-only deploy dirs, or data-retention mount points.
- Tuning env vars (defaults in `.env.example`): `MSE_HTTP_TIMEOUT`, `MSE_ASSET_MAX`,
  `MSE_DAILY_API_BUDGET`, `MSE_EMITTED_KEYS_CAP`, `MSE_LOOKBACK_DAYS`,
  `MSE_INITIAL_LOOKBACK_DAYS`.
- Wrangler-side: rows whose domain matches no `account` document are **skipped by design**
  (named-accounts-only). `skipped > 0` in the sink result is normal.

## Phase 6 — Acceptance checklist (the "done" gate)

- [ ] `mse auth` succeeds with the read-only API user.
- [ ] `mse recon` counts roughly match the Marketo UI; DQ issues reviewed with marketing ops.
- [ ] `signal-map.json` reviewed by a human who knows the instance; zero high-volume unmapped types.
- [ ] `mse test` journey for one known lead matches Marketo's activity log for that lead.
- [ ] A seller confirmed one snapshot is accurate and actionable.
- [ ] `mse harvest --once` twice in a row: second run emits 0 (dedupe + token advance working).
- [ ] Daemon/cron running; signals arriving at the configured sink.
- [ ] (Wrangler) `signal` documents with `source == "marketo"` visible within a week
      (`node scripts/prove-throughput.mjs` from the repo root).
- [ ] `mse explain` output shared with the GTM team.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Auth failed (HTTP 401)` | Wrong client id/secret, or LaunchPoint service not approved |
| `Marketo error 606` repeatedly | Another integration is consuming the 100/20s budget — increase harvest interval |
| Recon shows 0 programs/forms | API role lacks Read-Only Assets — fix the role, not the tool |
| `mse test` shows an empty journey | Lead exists but has no activity in the lookback window — try `--lookback 365` |
| Harvest emits nothing, ever | Check `outputs/.state.json` tokens aren't ahead (delete to re-baseline); confirm the mapped activity types actually occur |
| `another harvest is already running` | A daemon holds `outputs/.state.lock` — stop it, or wait; stale locks clear themselves after 15 min |
| `DAILY API BUDGET EXHAUSTED` in logs | The harvester hit `MSE_DAILY_API_BUDGET` — raise it if the volume is expected, or investigate what's pulling so much history |
| Wrangler sink `skipped` = everything | Domains aren't named accounts in Wrangler — expected unless the account exists |
