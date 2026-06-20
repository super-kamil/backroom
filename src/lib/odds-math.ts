/**
 * odds-math.ts — the deterministic crown jewel.
 *
 * Pure, hand-written, unit-tested math: implied probabilities, de-vigging,
 * the independent-Poisson 1X2 model, expected value, and stake sizing.
 * NO I/O, NO network, NO hidden dependencies. If this math is wrong, the whole
 * premise (challenging the bookmaker with a calibrated estimate) collapses.
 *
 * MVP MARKET: 1X2 only. "power" / "shin" de-vig are named extension points.
 */

import type {
  Outcome,
  OutcomeOdds,
  OutcomeProbs,
  QuantMath,
  TraderReport,
} from "./contracts.ts";
import { MATH_VERSION } from "./config.ts";

/** The deterministic de-vig + value view (TraderReport minus the prose fields). */
export type ValueView = Omit<TraderReport, "agent" | "notes">;

// The baseline slice the Quant consumes (PrefetchBundle.baseline shape).
type Baseline = {
  home: {
    matchesPlayed: number;
    goalsForPerHome: number;
    goalsAgainstPerHome: number;
  };
  away: {
    matchesPlayed: number;
    goalsForPerAway: number;
    goalsAgainstPerAway: number;
  };
  league: {
    avgHomeGoals: number;
    avgAwayGoals: number;
  };
};

// Sane bounds for a Poisson λ in a football match. Outside this and the model
// has either bad inputs or is being asked something physically implausible.
const LAMBDA_MIN = 0.05;
const LAMBDA_MAX = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Implied probabilities & overround
// ─────────────────────────────────────────────────────────────────────────────

/** Naive implied probability from a single decimal odd: 1 / odds. */
export function impliedProbFromOdds(odds: number): number {
  return 1 / odds;
}

/** Apply 1/odds across the three 1X2 outcomes. Sums to >1 by the overround. */
export function impliedProbs(odds: OutcomeOdds): OutcomeProbs {
  return {
    home: impliedProbFromOdds(odds.home),
    draw: impliedProbFromOdds(odds.draw),
    away: impliedProbFromOdds(odds.away),
  };
}

/** Bookmaker margin baked into the implied probs: (home+draw+away) − 1. */
export function overround(impl: OutcomeProbs): number {
  return impl.home + impl.draw + impl.away - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// De-vigging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proportional (a.k.a. normalized / "basic") de-vig: divide each implied prob by
 * their sum so the triple totals exactly 1.
 *
 * KNOWN-BIASED SIMPLIFICATION — this is the MVP default precisely because it is
 * simple, not because it is correct. It spreads the bookmaker margin EVENLY
 * across all three outcomes and therefore ignores the favorite-longshot bias
 * (real books load more margin onto longshots). The calibration log will expose
 * this; the "power" and "shin" methods below are the intended upgrades.
 */
export function devigProportional(odds: OutcomeOdds): OutcomeProbs {
  const impl = impliedProbs(odds);
  const sum = impl.home + impl.draw + impl.away;
  return {
    home: impl.home / sum,
    draw: impl.draw / sum,
    away: impl.away / sum,
  };
}

/**
 * De-vig dispatcher. "proportional" is implemented (MVP default). "power" and
 * "shin" are NAMED EXTENSION POINTS — deliberately unimplemented so the
 * calibration log can justify building them.
 */
export function devig(
  odds: OutcomeOdds,
  method: "proportional" | "power" | "shin",
): OutcomeProbs {
  switch (method) {
    case "proportional":
      return devigProportional(odds);
    case "power":
      throw new Error(
        'devig method "power" is not implemented (extension point)',
      );
    case "shin":
      throw new Error(
        'devig method "shin" is not implemented (extension point)',
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Poisson scoreline model
// ─────────────────────────────────────────────────────────────────────────────

/** k! for a non-negative integer k. */
function factorial(k: number): number {
  let acc = 1;
  for (let i = 2; i <= k; i++) acc *= i;
  return acc;
}

/**
 * Poisson PMF: P(X=k) = λ^k · e^(−λ) / k!.
 * Guards: k must be a non-negative integer (else 0); λ must be ≥ 0.
 */
export function poissonPmf(k: number, lambda: number): number {
  if (!Number.isInteger(k) || k < 0) return 0;
  if (lambda < 0) return 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * Joint scoreline matrix under independent Poisson: M[i][j] is the probability
 * of home scoring i and away scoring j, for i,j in 0..maxGoals. The tail beyond
 * maxGoals is truncated (negligible mass) and compensated at the collapse step.
 */
export function scorelineMatrix(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 10,
): number[][] {
  const homePmf: number[] = [];
  const awayPmf: number[] = [];
  for (let g = 0; g <= maxGoals; g++) {
    homePmf.push(poissonPmf(g, lambdaHome));
    awayPmf.push(poissonPmf(g, lambdaAway));
  }
  const matrix: number[][] = [];
  for (let i = 0; i <= maxGoals; i++) {
    const ph = homePmf[i] ?? 0;
    const row: number[] = [];
    for (let j = 0; j <= maxGoals; j++) {
      row.push(ph * (awayPmf[j] ?? 0));
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * Collapse a joint scoreline matrix into 1X2 probabilities. i>j → home win,
 * i===j → draw, i<j → away win. Each bucket is divided by the TOTAL matrix mass
 * so the triple sums to exactly 1 (this compensates for the truncated tail).
 */
export function outcomeProbsFromMatrix(matrix: number[][]): OutcomeProbs {
  let home = 0;
  let draw = 0;
  let away = 0;
  let total = 0;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const p = row[j] ?? 0;
      total += p;
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  if (total === 0) return { home: 0, draw: 0, away: 0 };
  return { home: home / total, draw: draw / total, away: away / total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Expected goals (independent-Poisson strength model)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard independent-Poisson attack/defense strength model. Strengths are the
 * team's per-match rate divided by the relevant league average; λ is then the
 * product of the relevant strengths scaled back by the league average.
 *
 * Divide-by-zero guard: if a league average is 0, fall back to the raw per-match
 * rate (no normalization possible). Each λ is clamped to LAMBDA_MIN..LAMBDA_MAX.
 */
export function expectedGoals(baseline: Baseline): {
  home: number;
  away: number;
} {
  const { home, away, league } = baseline;

  let lambdaHome: number;
  if (league.avgHomeGoals > 0) {
    const homeAttack = home.goalsForPerHome / league.avgHomeGoals;
    const awayDefense = away.goalsAgainstPerAway / league.avgHomeGoals;
    lambdaHome = homeAttack * awayDefense * league.avgHomeGoals;
  } else {
    lambdaHome = home.goalsForPerHome;
  }

  let lambdaAway: number;
  if (league.avgAwayGoals > 0) {
    const awayAttack = away.goalsForPerAway / league.avgAwayGoals;
    const homeDefense = home.goalsAgainstPerHome / league.avgAwayGoals;
    lambdaAway = awayAttack * homeDefense * league.avgAwayGoals;
  } else {
    lambdaAway = away.goalsForPerAway;
  }

  return {
    home: clampLambda(lambdaHome),
    away: clampLambda(lambdaAway),
  };
}

function clampLambda(lambda: number): number {
  if (!Number.isFinite(lambda)) return LAMBDA_MIN;
  return Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, lambda));
}

// ─────────────────────────────────────────────────────────────────────────────
// Full 1X2 computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * End-to-end deterministic 1X2 estimate: expectedGoals → scorelineMatrix →
 * outcomeProbsFromMatrix, plus the top-7 exact scores by probability.
 *
 * MVP DRAW RULE: pure independent Poisson systematically UNDER-predicts
 * low-scoring draws because it assumes home/away goals are independent — real
 * matches are mildly negatively correlated near 0-0/1-1. This is EXPECTED and we
 * deliberately add NO hand-tuned draw fudge factor. The calibration log will
 * surface the draw mis-calibration, and that evidence is what justifies the
 * eventual Dixon-Coles low-score correction upgrade.
 */
export function computeOneXTwo(baseline: Baseline): QuantMath {
  const lambda = expectedGoals(baseline);
  const matrix = scorelineMatrix(lambda.home, lambda.away);
  const probs = outcomeProbsFromMatrix(matrix);

  const scores: Array<{ home: number; away: number; prob: number }> = [];
  let total = 0;
  for (const row of matrix) for (const p of row) total += p;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const raw = row[j] ?? 0;
      scores.push({ home: i, away: j, prob: total > 0 ? raw / total : 0 });
    }
  }
  scores.sort((a, b) => b.prob - a.prob);
  const scorelineTopN = scores.slice(0, 7);

  return { lambda, probs, scorelineTopN, mathVersion: MATH_VERSION };
}

// ─────────────────────────────────────────────────────────────────────────────
// Value & staking
// ─────────────────────────────────────────────────────────────────────────────

const VALUE_OUTCOMES: readonly Outcome[] = ["home", "draw", "away"];

/**
 * De-vig the market and locate per-outcome value against OUR probabilities — the
 * single, deterministic implementation of the value rule shared by the live
 * Trader path (devig.ts) and the historical backtest (backtest.ts). Value exists
 * only where ourProb beats the vig-free fair prob by at least valueThreshold;
 * bestSelection is the highest-qualifying-edge outcome, or null when none clears
 * the bar. No interpretation, no rounding — pure arithmetic.
 */
export function computeValue(
  ourProbs: OutcomeProbs,
  rawOdds: OutcomeOdds,
  method: "proportional" | "power" | "shin",
  valueThreshold: number,
): ValueView {
  const impliedRaw = impliedProbs(rawOdds);
  const ovr = overround(impliedRaw);
  const fairProbs = devig(rawOdds, method);

  const value = {} as ValueView["value"];
  for (const o of VALUE_OUTCOMES) {
    const ourProb = ourProbs[o];
    const fairProb = fairProbs[o];
    const edge = ourProb - fairProb;
    value[o] = { ourProb, fairProb, edge, hasValue: edge >= valueThreshold };
  }

  let bestSelection: Outcome | null = null;
  let bestEdge = -Infinity;
  for (const o of VALUE_OUTCOMES) {
    const v = value[o];
    if (v.hasValue && v.edge > bestEdge) {
      bestEdge = v.edge;
      bestSelection = o;
    }
  }

  return {
    rawOdds,
    impliedRaw,
    overround: ovr,
    deVigMethod: method,
    fairProbs,
    value,
    bestSelection,
    valueThreshold,
  };
}

/** Expected value per unit stake: prob · decimalOdds − 1. */
export function expectedValue(prob: number, decimalOdds: number): number {
  return prob * decimalOdds - 1;
}

/** Fixed-percentage stake, capped at maxStake and floored at 0. */
export function fixedPctStake(
  bankroll: number,
  stakePct: number,
  maxStake: number,
): number {
  return Math.max(0, Math.min(bankroll * stakePct, maxStake));
}
