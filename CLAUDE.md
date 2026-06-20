# CLAUDE.md — project rules for backroom

**backroom** is a Football Match Analysis Factory: a multi-agent system that
challenges a bookmaker's 1X2 odds with an independent, calibrated probability
estimate and only bets when our number beats the vig-free fair price.

Read the spine before writing code: `src/lib/contracts.ts`, `src/lib/config.ts`,
`src/lib/run-paths.ts`. Match exported names exactly.

## Scope guardrails

- **MVP market is 1X2 (home/draw/away) ONLY.** Do not add Over/Under, BTTS, player
  props, or parlays.
- **Do not build the named extension points.** Lineup / Player / Context scouts,
  the Head Scout, Dixon-Coles, and the `power` / `shin` de-vig methods are
  deliberately unimplemented. The only allowed throw-stubs are these explicit,
  named extension points (e.g. `devig()` throwing for `power`/`shin`).

## Determinism boundary (non-negotiable)

- **All math and all data live in Bun scripts/libs. The LLM is for judgment only.**
  An agent never computes a number — the deterministic script writes a `*-math.json`
  and the agent reads it, interprets it, and writes its report.
- **Prefetch before any LLM.** Only `api-client.ts` touches the network.
- Every agent report passes the backpressure validator (`validators.ts` via
  `src/scripts/validate.ts`) before it is accepted: schema → bounds → consistency.

## Decision rules

- **NO-BET is a first-class output.** A run that finds no qualifying edge, or fails
  the Data Quality Gate, ends in NO-BET — that is success, not failure.
- **NEVER hand-tune the draw probability.** Pure independent Poisson under-predicts
  low-scoring draws; leave it uncorrected so the calibration log exposes it. That
  evidence is what would justify a future Dixon-Coles upgrade — do not pre-empt it
  with a fudge factor.
- **Every prediction must be versioned and logged.** Each `FinalDecision` carries a
  `PipelineVersion` stamp (`buildVersionStamp` in `config.ts`) and is written to
  the calibration log so calibration changes are attributable.

## Engineering rules

- **Zero external dependencies.** Bun 1.3 only — `fetch`, `bun:sqlite`, `bun test`,
  native `.env`. Do **not** add npm packages or run `bun install` for runtime deps.
- TypeScript is strict: `noUncheckedIndexedAccess` (guard `arr[i]`),
  `verbatimModuleSyntax` (use `import type` for types), local imports include the
  `.ts` extension, ESM only.
- **Before declaring anything done, run `bun test` and `tsc --noEmit`** and make
  them pass. All non-trivial math must be unit-tested, never a black box.
- Do not edit `package.json`, `tsconfig.json`, or other agents' assigned files.

## LIVING-DIAGRAM RULE

When the agent roster, the flow, or the model assignments change, update the mermaid
diagrams (in `README.md` and `AGENTS.md`) **in the same change**. A stale diagram is
worse than none; updating it is part of done.
