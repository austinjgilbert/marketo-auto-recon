# Marketo Auto Recon — the product idea

*One page for the person deciding whether this is worth their afternoon.*

## The problem

Almost every B2B company with Marketo has the same situation:

- The instance is **years of accumulated mess** — hundreds of fields, dead programs, custom
  activities nobody remembers creating. The engineers who understand it have left or are
  scared to touch it.
- Meanwhile it is quietly recording **the most valuable dataset in the company**: every form
  fill, page visit, email click, score change, and event attendance for every buyer — the
  complete, timestamped story of how each account is (or isn't) buying.
- Sellers never see any of it. When a "Contact Sales" form comes in, the rep gets a name and
  an email. The three months of pricing-page visits, the two colleagues who binged the docs
  last week, the stall in April — all invisible.

The gap is not data. The gap is that nobody can get the data **out**, **normalized**, and
**in front of a seller at the moment it matters**.

## The thesis

You don't need a data team, a CDP project, or six months. You need a tool that:

1. **Understands the instance for you.** Automated reconnaissance catalogs everything in the
   instance and flags what's junk — the "archaeologist" step that usually takes a consultant
   weeks.
2. **Makes the mapping explicit and human-owned.** Heuristics classify every activity type and
   form into a small canonical taxonomy, with a confidence and rationale on every mapping —
   then a human reviews one JSON file. No black box; the map *is* the contract.
3. **Normalizes history into journeys.** Raw activity logs become one chronological story per
   lead and per account: stage, stalls, topics, velocity, buying committee.
4. **Answers the seller's question in 20 seconds.** A hand-raise comes in → a 9-section brief:
   who this is, what they've been consuming, where they got stuck, what to say, who else is
   involved, what to do next. Idiot-proof by design.
5. **Never sleeps.** A daemon watches for state changes — form fills, pricing visits, content
   binges, stalls, reactivations, committee growth — and emits deduped, evidence-backed
   signals to whatever system acts on them (a file, a webhook, a CRM, an agent pipeline).

**Signal → action is the goal.** Everything else is plumbing in service of a seller doing the
right human thing at the right moment.

## Who it's for

- **The engineer** who was just told "figure out what's in our Marketo" — recon + explain give
  them an instance map and a data-quality audit on day one.
- **Sales/RevOps leadership** who want sellers acting on buyer behavior without buying another
  platform — snapshots and the harvest daemon are the product.
- **Builders** who want a normalized signal feed for their own agent or workflow system — the
  journey blob and canonical signal schema are the integration surface.

## Design principles (why it's built this way)

| Principle | Consequence |
|---|---|
| Trust is the bottleneck, not tech | Read-only client (GET-only except the OAuth handshake POST, test-enforced); every signal carries the raw activity IDs behind it |
| A human owns the mapping | `signal-map.json` is plain, hand-editable JSON with confidence + rationale per row; unmapped types are flagged, never silently dropped |
| Zero adoption friction | No npm dependencies, no database, no infrastructure — Node ≥ 18 and a `.env` file |
| Prove before you scale | `--mock` mode demos everything without credentials; `mse test` validates the map on one lead before you run thousands |
| Deterministic first, LLM second | Everything works without an API key; Claude optionally adds narrative polish and mapping suggestions, never load-bearing logic |
| Signals decay, evidence doesn't | Dedupe keys and persisted state prevent re-alerting; thresholds are tunable in the map file |

## What this is not

- Not a Marketo admin or cleanup tool — it reads, maps, and reports; it never writes to Marketo.
- Not a CDP or a data warehouse — no storage beyond local output files and whatever sink you point it at.
- Not an outbound tool — it tells a human (or your downstream system) *what changed and why it
  matters*; acting on it stays yours.

## Where to go next

- Try it in 60 seconds: `npm run demo` (see [README.md](README.md))
- Adoption path + build-on-top ideas: [PLAN.md](PLAN.md)
- Technical reference: [REFERENCE.md](REFERENCE.md)
