# Contributing

## Ground rules (the trust contract)

1. **No write paths to Marketo, ever.** The client is GET-only and a test enforces it. PRs
   adding write capability will be declined regardless of how useful they are.
2. **Every signal carries evidence and a dedupe key.** No unexplainable alerts.
3. **Configuration goes in `signal-map.json`, not code.** If your feature needs tuning, make
   it a map field a human can edit.
4. **The core stays dependency-free.** Node ≥ 18 stdlib only. Sinks may talk to anything over
   `fetch`, but `npm install` must never be required to run the engine.
5. **Deterministic first.** LLM calls are optional garnish; nothing may require an API key to
   function.

## Dev setup

```bash
git clone https://github.com/austinjgilbert/marketo-auto-recon.git
cd marketo-auto-recon
npm test        # node:test, fully offline — 46 tests
npm run demo    # full pipeline against fixtures/, writes to outputs/
```

There is no build step, no transpiler, and nothing to install.

## Where things live

See the code map in [REFERENCE.md](REFERENCE.md). The short version: `bin/mse.js` dispatches;
each stage is one module in `src/`; `src/mock-transport.js` + `fixtures/instance.js` are the
synthetic instance behind `--mock`.

## Adding things

- **A sink:** copy `src/sinks/webhook.js`. A sink exports one async function receiving
  `(signals, config)`. Register it in `src/harvester.js`, add env docs to `.env.example`, add
  a test mirroring `tests/sinks.test.js`.
- **A pattern signal:** add an extractor in `src/interpreter.js`. It receives the journey blob
  and prior pattern state, returns signals with stable `dedupeKey`s, and records its state in
  `nextPatternState` so restarts don't re-fire. Add fixture activity that triggers it and a
  test that proves it fires once and only once.
- **A snapshot section:** sections are independent builders in `src/snapshot.js` over the
  interpreted journey. Keep them useful to a seller in under 15 seconds of reading.
- **Heuristics:** classification rules live in `src/signal-map.js`. Order matters — `ignore`
  rules run first on purpose. Every rule needs a fixture case.

## Tests

`node --test tests/*.test.js`. Fixtures are deterministic; if your change needs new behavior,
extend `fixtures/instance.js` rather than mocking modules. CI runs the suite, the full mock
demo, and a harvest-dedupe invariant (a second harvest must emit zero signals) on every PR.
