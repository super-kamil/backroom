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

## Run modes — live vs validation (set MODE correctly)

- **Two modes source data differently; `MODE` (`config.ts`) defaults to `validation`.**
  - `live` — an **upcoming** fixture: season-to-date `/teams/statistics` baseline,
    last-N form across **all** competitions, FRESH odds. **This is the mode for
    `/analyze-match`.**
  - `validation` — a **completed** season replayed AS-OF each kickoff (no lookahead)
    for backtesting / calibration (`backtest.ts`, `/review-matchday`). It restricts
    form and baseline to that competition's pre-kickoff fixtures, so it will
    (correctly) fail the gate on an upcoming match — the wrong path for live analysis.
- **`/analyze-match` is LIVE analysis — run prefetch with `MODE=live`.** Because the
  default is `validation`, until `.env` sets `MODE=live` invoke prefetch as
  `MODE=live bun run src/scripts/prefetch.ts <id>` (do the same for any one-off
  fixture lookup). A run started under `validation` fails the gate for the wrong
  reason and must not be presented as a live verdict.
- **Resolve team names → fixtureId first.** `/analyze-match` takes an integer
  API-Football fixture id. When the user names teams + a date ("Belgium vs Iran
  today"), look the id up via `/fixtures?date=YYYY-MM-DD` (the only network access is
  still through `api-client.ts` / the prefetch path) before starting the runbook.
- **A competition can only be priced when it exposes a usable season-to-date
  baseline.** The independent Poisson needs per-venue team scoring rates _and_
  league averages built from matches already played this season. This fails two
  ways: (a) coverage gaps — `statistics`/`standings` report `false`; or (b) a
  season with too few matches played, so the per-venue `matchesPlayed` and the
  league averages are still ~0. A just-started international tournament hits (b):
  e.g. the World Cup group stage reports `statistics:true` yet has neutral venues
  and near-zero home/away history, so `avgHomeGoals`/`avgAwayGoals` are 0 and the
  gate (`data-quality-gate.ts`) correctly ends in NO-BET. That is the gate
  working, not a bug.

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

- **Zero external _runtime_ dependencies.** Bun 1.3 only — `fetch`, `bun:sqlite`,
  `bun test`, native `.env`. Do **not** add npm packages or run `bun install` for
  runtime deps. The sole sanctioned exception is **Prettier**, a dev-only formatter
  (`devDependencies`, never imported by shipped code); run it with `bun run format`
  (check-only: `bun run format:check`). Do not add any other dev or runtime package
  without the same explicit sign-off.
- TypeScript is strict: `noUncheckedIndexedAccess` (guard `arr[i]`),
  `verbatimModuleSyntax` (use `import type` for types), local imports include the
  `.ts` extension, ESM only.
- **Before declaring anything done, run `bun test` and `tsc --noEmit`** and make
  them pass. All non-trivial math must be unit-tested, never a black box.
- Do not edit `package.json`, `tsconfig.json`, or other agents' assigned files.
  (The `format` / `format:check` scripts and the `prettier` devDependency were added
  under explicit sign-off — see the dependencies rule above.)

## LIVING-DIAGRAM RULE

When the agent roster, the flow, or the model assignments change, update the mermaid
diagrams (in `README.md` and `AGENTS.md`) **in the same change**. A stale diagram is
worse than none; updating it is part of done.
