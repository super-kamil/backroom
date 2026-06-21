---
name: review-matchday
description: Manually review the past matchday's calibration once results are in — settle finished predictions, recompute Brier / reliability / hit-rate / flat-staking P&L, and write a plain-language calibration review with optional factory-tuning suggestions for human approval. Triggered by /review-matchday. Use when the user wants to grade past predictions, check model calibration, or review how the factory performed after matches finished.
---

# Head Coach — review-matchday runbook

This is a **thin orchestration over deterministic scripts**. The scripts settle
results and compute every metric; **the LLM only writes the human summary**. You do
**not** compute Brier, reliability, hit rate, or P&L yourself, and you do **not**
rummage through old `runs/<id>/` directories or re-derive anything — you read one
file (`data/metrics.json`) and report on it.

> Run this **manually, once results are in.** It is not part of the pre-match
> pipeline; the user invokes it after a matchday's fixtures have finished so the
> outcomes exist to settle against.

## Step 1 — SETTLE (deterministic)

Run:

```
bun run src/scripts/settle.ts
```

This fetches finished match results, resolves every open prediction to its 1X2
outcome, and writes the actual outcomes plus each row's Brier contribution back into
the calibration log. It touches the network and needs the API key. No LLM judgment
here. If it reports rows still open (matches not yet finished), that is normal — they
settle on a later run.

## Step 2 — COMPUTE (deterministic)

Run:

```
bun run src/scripts/metrics.ts
```

This recomputes two families and writes both to `data/metrics.json` — the only
file the summary step reads:

- `betting` — over the **full settled live-chain history**: mean Brier (binary on
  the selection), reliability buckets (predicted vs observed hit frequency), hit
  rate, flat-staking P/L.
- `validation` — over the **backtest calibration rows** (populated by
  `bun run src/scripts/backtest.ts`, if you have run it): multiclass Brier vs the
  base-rate baseline, top-pick accuracy, the multiclass reliability curve, and a
  flat-stake value P/L. May be empty if no backtest has been run — that is fine.

## Step 3 — SUMMARIZE (Sonnet-level reporting — no high-stakes reasoning)

Read `data/metrics.json` and write a **plain-language matchday review**. This is a
reporting task, not a reasoning task: describe what the numbers say, do not invent
analysis beyond them. Cover:

- **What was predicted** vs **what landed** this matchday (selections and outcomes,
  the settled count).
- **Where the model was over- or under-confident** — read it off the reliability
  buckets (e.g. "predictions in the 60–70% bin only hit ~50% of the time →
  over-confident there"). Use the `betting` buckets and, if present, the richer
  `validation` multiclass reliability curve.
- **The calibration trend** — is mean Brier improving or drifting; how does P&L and
  hit rate look over the history. If `validation` is present, say whether the
  multiclass Brier beats the base-rate baseline (real skill) or not, and call out
  the known draw under-prediction if the buckets show it.
- **OPTIONAL factory-tuning suggestions, for HUMAN APPROVAL.** Agents propose,
  humans approve — never apply changes here. Frame each as a hypothesis tied to the
  evidence, naming what might need attention:
  - a specific **agent / prompt** (e.g. the form-scout over-weighting recency),
  - a **model** assignment,
  - a **threshold** (`VALUE_THRESHOLD`, stake caps),
  - the **de-vig method** (`proportional` / `power` / `shin`).
    Make clear these are suggestions requiring human sign-off, not actions taken.

Tone: honest and non-promotional. If the sample is too small to conclude anything,
say so plainly rather than over-reading noise. Surface miscalibration candidly —
the point of this review is to catch the model fooling itself.

## GUARDRAILS

- The LLM **never computes** metrics and **never edits** the calibration log or old
  runs — it only reads `data/metrics.json` and writes prose.
- All tuning suggestions are **proposals for human approval**, never auto-applied.
- Do not over-interpret a thin sample; state uncertainty honestly.
