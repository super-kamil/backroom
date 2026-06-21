/**
 * model-plausibility.ts — a pure, deterministic reliability check on the
 * independent-Poisson estimate.
 *
 * Runs AFTER the Poisson compute + de-vig but BEFORE any LLM agent, so a
 * structurally un-priceable fixture fails CHEAPLY (no token spend) instead of
 * being handed to an agent that then has to reason its way around a degenerate
 * number. It does NOT change the math and it NEVER hand-tunes a probability — it
 * only FLAGS when the computed estimate is unreliable.
 *
 * Motivating case (Belgium vs Iran, neutral-venue World Cup): the strength
 * normalization deflated the effective home λ to 0.901 against a raw scoring
 * rate of 3.8 (a 0.237 deflation ratio) and the away λ collapsed to 0.146,
 * producing a 39.9% draw that diverged ~24pp from API-Football's own model and
 * ran far above the market's vig-free fair draw of 20.7%. The arithmetic was
 * correct; the INPUT was degenerate. This module detects exactly that shape.
 *
 * NO I/O, NO network, NO hidden dependencies — a single pure function over
 * already-computed numbers.
 *
 * MVP MARKET: 1X2 only.
 */

import type { OutcomeProbs } from "./contracts.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds (the only tunable knobs — kept here, exported, and unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A λ below this is degenerate. A real football side scoring 0.146 goals/game is
 * not a credible estimate; below MIN_PLAUSIBLE_LAMBDA the Poisson collapse is
 * dominated by the 0-0 cell and the 1X2 triple stops describing a real match.
 */
export const MIN_PLAUSIBLE_LAMBDA = 0.4;

/**
 * If a team's effective λ divided by its raw per-match scoring rate falls below
 * this — i.e. the normalization deflated the FAVORITE to less than half its own
 * scoring rate — the strength-normalization is fighting the data and the result
 * is degenerate. (Belgium: 0.901 / 3.8 = 0.237 < 0.5 → flagged.)
 */
export const MAX_FAVORITE_DEFLATION = 0.5;

/**
 * If the API cross-check is present and our probability differs from the API's
 * on ANY outcome by more than this, flag it (warn — a disagreement, not proof we
 * are wrong).
 */
export const MAX_API_DIVERGENCE = 0.2;

/**
 * If the market vig-free fair draw is present and our draw exceeds it by more
 * than this multiple, flag it (warn — the independent Poisson is known to drift
 * high on draws, but this is an extreme that warrants attention).
 */
export const MAX_DRAW_OVER_MARKET = 1.5;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One reason the estimate may be unreliable. `severity` "degenerate" makes the
 * whole result unreliable; "warn" is advisory and does not by itself block.
 */
export interface PlausibilityFlag {
  code: string;
  detail: string;
  severity: "warn" | "degenerate";
}

/**
 * The verdict. `reliable` is `false` iff there is at least one "degenerate"
 * flag; "warn"-only results stay reliable but carry advisory flags.
 */
export interface PlausibilityResult {
  reliable: boolean;
  flags: PlausibilityFlag[];
}

/** Input to {@link assessModelPlausibility}. All numbers are already computed. */
export interface PlausibilityInput {
  /** Effective Poisson expected goals per side (post-normalization, clamped). */
  lambda: { home: number; away: number };
  /** Our independent 1X2 estimate. */
  probs: OutcomeProbs;
  /** Raw per-match scoring rates from the baseline (goalsForPerHome/Away). */
  scoringRates: { home: number; away: number };
  /** Optional API-Football cross-check. Omit / null when unavailable. */
  apiProbs?: OutcomeProbs | null;
  /** Optional vig-free fair draw from the de-vig. Omit / null when unavailable. */
  marketFairDraw?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assessment
// ─────────────────────────────────────────────────────────────────────────────

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Assess whether the computed 1X2 estimate is reliable. Pure: it derives flags
 * only from the numbers passed in and never mutates them.
 *
 * Checks:
 *   1. degenerate-λ          — home or away λ < MIN_PLAUSIBLE_LAMBDA.   (degenerate)
 *   2. favorite-deflation    — the higher-raw-scoring side's λ / rate
 *                              < MAX_FAVORITE_DEFLATION (guarded so a 0 raw
 *                              scoring rate is skipped, never a divide-by-zero). (degenerate)
 *   3. api-divergence        — |ours − API| on ANY outcome > MAX_API_DIVERGENCE. (warn)
 *   4. draw-over-market      — our draw > marketFairDraw · MAX_DRAW_OVER_MARKET. (warn)
 */
export function assessModelPlausibility(
  input: PlausibilityInput,
): PlausibilityResult {
  const { lambda, probs, scoringRates, apiProbs, marketFairDraw } = input;
  const flags: PlausibilityFlag[] = [];

  // 1. Degenerate λ — checked per side so both can fire independently.
  if (lambda.home < MIN_PLAUSIBLE_LAMBDA) {
    flags.push({
      code: "degenerate-lambda-home",
      detail: `home λ ${round(lambda.home)} is below the plausible floor ${MIN_PLAUSIBLE_LAMBDA}`,
      severity: "degenerate",
    });
  }
  if (lambda.away < MIN_PLAUSIBLE_LAMBDA) {
    flags.push({
      code: "degenerate-lambda-away",
      detail: `away λ ${round(lambda.away)} is below the plausible floor ${MIN_PLAUSIBLE_LAMBDA}`,
      severity: "degenerate",
    });
  }

  // 2. Favorite deflation — only the side with the higher RAW scoring rate; the
  //    favorite being deflated below half its own rate means the normalization
  //    is fighting the data. Guard divide-by-zero: skip if that rate is 0.
  const favoriteIsHome = scoringRates.home >= scoringRates.away;
  const favoriteRate = favoriteIsHome ? scoringRates.home : scoringRates.away;
  const favoriteLambda = favoriteIsHome ? lambda.home : lambda.away;
  const favoriteSide = favoriteIsHome ? "home" : "away";
  if (favoriteRate > 0) {
    const deflation = favoriteLambda / favoriteRate;
    if (deflation < MAX_FAVORITE_DEFLATION) {
      flags.push({
        code: "favorite-deflation",
        detail: `favorite (${favoriteSide}) effective λ ${round(favoriteLambda)} is only ${round(deflation)}× its raw scoring rate ${round(favoriteRate)} (below ${MAX_FAVORITE_DEFLATION}) — normalization is fighting the data`,
        severity: "degenerate",
      });
    }
  }

  // 3. API divergence — only when the cross-check is present.
  if (apiProbs != null) {
    const maxDiff = Math.max(
      Math.abs(probs.home - apiProbs.home),
      Math.abs(probs.draw - apiProbs.draw),
      Math.abs(probs.away - apiProbs.away),
    );
    if (maxDiff > MAX_API_DIVERGENCE) {
      flags.push({
        code: "api-divergence",
        detail: `our 1X2 diverges from API-Football by ${round(maxDiff)} on at least one outcome (above ${MAX_API_DIVERGENCE})`,
        severity: "warn",
      });
    }
  }

  // 4. Draw over market — only when a positive fair draw is present.
  if (marketFairDraw != null && marketFairDraw > 0) {
    if (probs.draw > marketFairDraw * MAX_DRAW_OVER_MARKET) {
      flags.push({
        code: "draw-over-market",
        detail: `our draw ${round(probs.draw)} exceeds ${MAX_DRAW_OVER_MARKET}× the market fair draw ${round(marketFairDraw)} (${round(marketFairDraw * MAX_DRAW_OVER_MARKET)})`,
        severity: "warn",
      });
    }
  }

  return {
    reliable: flags.every((f) => f.severity !== "degenerate"),
    flags,
  };
}
