/**
 * calibration-metrics.ts — PURE functions over settled prediction records.
 *
 * No DB access: the caller pulls rows (e.g. via CalibrationLog.getAllSettled /
 * getAllCalibration) and passes them in.
 *
 * TWO families live here:
 *   1. BETTING metrics over settled PredictionRecord rows — a BET scored as a
 *      BINARY calibration problem on the SELECTED outcome (ourProb = P(selection
 *      occurs); event = "selection === actualOutcome"). Answers "do our 70% calls
 *      land 70% of the time?" without the full triple.
 *   2. VALIDATION metrics over CalibrationPrediction rows — the FULL multiclass
 *      1X2 triple vs the realized outcome (Brier, reliability, accuracy, base-rate
 *      skill), plus a flat-stake value P&L when a row carries a `market` block.
 */

import type {
  CalibrationPrediction,
  FinalDecision,
  Outcome,
  OutcomeProbs,
} from "./contracts.ts";

/** Minimal settled-row shape the metrics read. */
export interface SettledRecord {
  decision: FinalDecision;
  actualOutcome: Outcome | null;
}

/** A BET row that is fully scoreable as a binary selection event. */
interface BetEvent {
  ourProb: number;
  hit: boolean;
  odds: number | null;
}

/**
 * Narrow a settled record to a scoreable binary BET event, or null.
 * Requires: recommendation BET, non-null selection, non-null ourProb,
 * non-null actualOutcome.
 */
function toBetEvent(r: SettledRecord): BetEvent | null {
  const d = r.decision;
  if (d.recommendation !== "BET") return null;
  if (d.selection === null) return null;
  if (d.ourProb === null) return null;
  if (r.actualOutcome === null) return null;
  return {
    ourProb: d.ourProb,
    hit: d.selection === r.actualOutcome,
    odds: d.odds,
  };
}

function betEvents(records: SettledRecord[]): BetEvent[] {
  const out: BetEvent[] = [];
  for (const r of records) {
    const e = toBetEvent(r);
    if (e !== null) out.push(e);
  }
  return out;
}

/** Single-prediction Brier contribution: (ourProb − outcome)^2, outcome ∈ {0,1}. */
export function brierForPrediction(ourProb: number, hit: boolean): number {
  const y = hit ? 1 : 0;
  const e = ourProb - y;
  return e * e;
}

/** Mean Brier over all scoreable BET records; null if there are none. */
export function meanBrier(records: SettledRecord[]): number | null {
  const events = betEvents(records);
  if (events.length === 0) return null;
  let sum = 0;
  for (const e of events) sum += brierForPrediction(e.ourProb, e.hit);
  return sum / events.length;
}

export interface ReliabilityBucket {
  /** [lo, hi) probability range for this bucket; the top bucket is [lo, hi]. */
  range: [number, number];
  count: number;
  /** Mean ourProb of records in the bucket (NaN-safe: 0 when empty). */
  predictedAvg: number;
  /** Fraction of records in the bucket whose selection actually occurred. */
  observedFreq: number;
}

/**
 * The calibration curve: bucket BET records by ourProb into nBuckets
 * equal-width slices over [0,1]. predictedAvg vs observedFreq per bucket tells
 * you whether the probabilities are honest. Empty buckets report 0/0.
 */
export function reliabilityBuckets(
  records: SettledRecord[],
  nBuckets = 10,
): ReliabilityBucket[] {
  const n = Math.max(1, Math.floor(nBuckets));
  const width = 1 / n;
  const sums = new Array<number>(n).fill(0); // Σ ourProb
  const hits = new Array<number>(n).fill(0); // Σ hit
  const counts = new Array<number>(n).fill(0);

  for (const e of betEvents(records)) {
    // Clamp into [0,1], then assign; ourProb === 1 lands in the top bucket.
    const p = e.ourProb < 0 ? 0 : e.ourProb > 1 ? 1 : e.ourProb;
    let idx = Math.floor(p / width);
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    sums[idx] = (sums[idx] ?? 0) + p;
    hits[idx] = (hits[idx] ?? 0) + (e.hit ? 1 : 0);
    counts[idx] = (counts[idx] ?? 0) + 1;
  }

  const buckets: ReliabilityBucket[] = [];
  for (let i = 0; i < n; i++) {
    const lo = i * width;
    const hi = i === n - 1 ? 1 : (i + 1) * width;
    const count = counts[i] ?? 0;
    const sum = sums[i] ?? 0;
    const hit = hits[i] ?? 0;
    buckets.push({
      range: [lo, hi],
      count,
      predictedAvg: count > 0 ? sum / count : 0,
      observedFreq: count > 0 ? hit / count : 0,
    });
  }
  return buckets;
}

/** Fraction of BET records whose selection matched the actual outcome; null if none. */
export function hitRate(records: SettledRecord[]): number | null {
  const events = betEvents(records);
  if (events.length === 0) return null;
  let hit = 0;
  for (const e of events) if (e.hit) hit++;
  return hit / events.length;
}

export interface ProfitLoss {
  /** Number of BET records staked. */
  bets: number;
  /** Total amount staked (bets * stakeUnit). */
  staked: number;
  /** Net profit: wins add (odds−1)*stakeUnit, losses subtract stakeUnit. */
  profit: number;
  /** Return on investment: profit / staked (0 when nothing staked). */
  roi: number;
}

/**
 * Flat-stake backtest: stake one unit on every BET at the recorded odds.
 * A winning selection returns (odds−1)*stakeUnit profit; a loss costs the
 * stakeUnit. NO-BET rows (and BETs with null odds) are ignored.
 */
export function profitLossFlat(
  records: SettledRecord[],
  stakeUnit = 1,
): ProfitLoss {
  let bets = 0;
  let profit = 0;
  for (const e of betEvents(records)) {
    if (e.odds === null) continue;
    bets++;
    if (e.hit) profit += (e.odds - 1) * stakeUnit;
    else profit -= stakeUnit;
  }
  const staked = bets * stakeUnit;
  return { bets, staked, profit, roi: staked > 0 ? profit / staked : 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multiclass calibration over CalibrationPrediction[] (validation mode)
//
// Unlike the betting metrics above — which score only the SELECTED outcome as a
// binary event — these score the FULL 1X2 probability triple against the realized
// outcome. This is the honest "do our 70% calls land at 70%?" core of validation
// mode. A prediction is SETTLED when actualOutcome is non-null.
// ─────────────────────────────────────────────────────────────────────────────

/** The three 1X2 outcomes, in a fixed iteration order. */
const OUTCOMES: readonly Outcome[] = ["home", "draw", "away"];

/** A CalibrationPrediction narrowed to a settled (actualOutcome != null) one. */
interface SettledPrediction {
  probs: OutcomeProbs;
  actualOutcome: Outcome;
}

/** Keep only settled predictions, projected onto the fields the metrics read. */
function settledPredictions(
  preds: CalibrationPrediction[],
): SettledPrediction[] {
  const out: SettledPrediction[] = [];
  for (const p of preds) {
    if (p.actualOutcome === null) continue;
    out.push({ probs: p.probs, actualOutcome: p.actualOutcome });
  }
  return out;
}

/**
 * Multiclass Brier contribution for ONE prediction vs its realized outcome:
 *   Σ_o (probs[o] − (o === actual ? 1 : 0))^2
 * Ranges 0..2 (0 = perfect, 2 = maximally wrong). The single source of the
 * per-row multiclass Brier — used by `multiclassBrier` and by the backtest runner.
 */
export function multiclassBrierOne(
  probs: OutcomeProbs,
  actual: Outcome,
): number {
  let sum = 0;
  for (const o of OUTCOMES) {
    const y = o === actual ? 1 : 0;
    const e = probs[o] - y;
    sum += e * e;
  }
  return sum;
}

/**
 * Multiclass Brier score: mean over settled predictions of the per-prediction
 * contribution (see multiclassBrierOne). Null when nothing is settled.
 */
export function multiclassBrier(preds: CalibrationPrediction[]): number | null {
  const settled = settledPredictions(preds);
  if (settled.length === 0) return null;
  let sum = 0;
  for (const s of settled) sum += multiclassBrierOne(s.probs, s.actualOutcome);
  return sum / settled.length;
}

/** argmax over the 1X2 triple; ties resolve in OUTCOMES order (home>draw>away). */
function argmaxOutcome(probs: OutcomeProbs): Outcome {
  let best: Outcome = "home";
  let bestProb = probs.home;
  for (const o of OUTCOMES) {
    if (probs[o] > bestProb) {
      bestProb = probs[o];
      best = o;
    }
  }
  return best;
}

/**
 * Top-pick accuracy: fraction of settled predictions whose most-likely outcome
 * (argmax of the triple) equals the actual outcome. Null when nothing is settled.
 */
export function accuracy(preds: CalibrationPrediction[]): number | null {
  const settled = settledPredictions(preds);
  if (settled.length === 0) return null;
  let correct = 0;
  for (const s of settled) {
    if (argmaxOutcome(s.probs) === s.actualOutcome) correct++;
  }
  return correct / settled.length;
}

export interface MulticlassReliabilityBucket {
  /** [lo, hi) probability range for this bucket; the top bucket is [lo, hi]. */
  range: [number, number];
  /** Number of POOLED (predicted-prob, hit) points in this bucket. */
  count: number;
  /** Mean predicted probability of the pooled points (0 when empty). */
  predictedAvg: number;
  /** Fraction of pooled points whose outcome actually occurred (0 when empty). */
  observedFreq: number;
}

/**
 * Multiclass reliability curve. POOL the three (probs[o], hit) points — one per
 * outcome — from every settled prediction, where hit = (o === actualOutcome).
 * Bucket the pooled predicted probabilities into nBuckets equal-width slices over
 * [0,1]; per bucket report predictedAvg vs observedFreq. Empty buckets report 0/0.
 *
 * Because every settled prediction contributes exactly one hit (its actual
 * outcome) and two misses, this directly answers "of all the times we said ~p,
 * how often did that outcome occur?" across the whole triple.
 */
export function reliabilityMulticlass(
  preds: CalibrationPrediction[],
  nBuckets = 10,
): MulticlassReliabilityBucket[] {
  const n = Math.max(1, Math.floor(nBuckets));
  const width = 1 / n;
  const sums = new Array<number>(n).fill(0); // Σ predicted prob
  const hits = new Array<number>(n).fill(0); // Σ hit
  const counts = new Array<number>(n).fill(0);

  for (const s of settledPredictions(preds)) {
    for (const o of OUTCOMES) {
      const raw = s.probs[o];
      // Clamp into [0,1], then assign; prob === 1 lands in the top bucket.
      const p = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      let idx = Math.floor(p / width);
      if (idx >= n) idx = n - 1;
      if (idx < 0) idx = 0;
      const hit = o === s.actualOutcome ? 1 : 0;
      sums[idx] = (sums[idx] ?? 0) + p;
      hits[idx] = (hits[idx] ?? 0) + hit;
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
  }

  const buckets: MulticlassReliabilityBucket[] = [];
  for (let i = 0; i < n; i++) {
    const lo = i * width;
    const hi = i === n - 1 ? 1 : (i + 1) * width;
    const count = counts[i] ?? 0;
    const sum = sums[i] ?? 0;
    const hit = hits[i] ?? 0;
    buckets.push({
      range: [lo, hi],
      count,
      predictedAvg: count > 0 ? sum / count : 0,
      observedFreq: count > 0 ? hit / count : 0,
    });
  }
  return buckets;
}

/**
 * Reference multiclass Brier from a naive constant model that ALWAYS predicts the
 * empirical base rates of home/draw/away observed across the settled set. This is
 * the "no-skill" baseline: a model that ignores every match and just outputs the
 * league's average outcome distribution. Comparing multiclassBrier(preds) against
 * baseRateBrier(preds) shows whether our per-match probabilities add real skill —
 * a calibrated, informative model should score MEASURABLY below this baseline.
 *
 * Null when nothing is settled.
 */
export function baseRateBrier(preds: CalibrationPrediction[]): number | null {
  const settled = settledPredictions(preds);
  if (settled.length === 0) return null;

  // Empirical base rates = outcome counts / total, over the settled set.
  const counts: Record<Outcome, number> = { home: 0, draw: 0, away: 0 };
  for (const s of settled) counts[s.actualOutcome]++;
  const total = settled.length;
  const baseRate: OutcomeProbs = {
    home: counts.home / total,
    draw: counts.draw / total,
    away: counts.away / total,
  };

  // Score that single constant triple against each realized outcome.
  let sum = 0;
  for (const s of settled) {
    for (const o of OUTCOMES) {
      const y = o === s.actualOutcome ? 1 : 0;
      const e = baseRate[o] - y;
      sum += e * e;
    }
  }
  return sum / total;
}

export interface ValueBacktestResult {
  /** Number of settled rows whose value rule fired a bet (market.bestSelection != null). */
  bets: number;
  /** Total staked (bets × stakeUnit). */
  staked: number;
  /** Net profit: a winning selection returns (odds−1)×unit; a loss costs the unit. */
  profit: number;
  /** Return on investment: profit / staked (0 when nothing staked). */
  roi: number;
  /** Fraction of fired bets that won; null when none fired. */
  hitRate: number | null;
}

/**
 * Flat-stake value P&L over backtest rows that carry a `market` block: stake one
 * unit on each row whose de-vig value rule selected an outcome
 * (market.bestSelection), at the recorded raw odds, and settle against the known
 * actualOutcome. Rows without a market block, without a selection, or still
 * unsettled are skipped.
 *
 * HONEST CEILING: this is the value rule applied mechanically — it does NOT model
 * the live Sharp/Risk vetoes that would remove some of these bets, so treat the
 * ROI as an upper bound on what the disciplined live chain would have staked.
 */
export function valueBacktest(
  preds: CalibrationPrediction[],
  stakeUnit = 1,
): ValueBacktestResult {
  let bets = 0;
  let profit = 0;
  let hits = 0;
  for (const p of preds) {
    if (p.actualOutcome === null) continue;
    const m = p.market;
    if (!m || m.bestSelection === null) continue;
    const odds = m.rawOdds[m.bestSelection];
    if (!(odds > 1)) continue; // malformed odds → not a scoreable bet
    bets++;
    if (m.bestSelection === p.actualOutcome) {
      profit += (odds - 1) * stakeUnit;
      hits++;
    } else {
      profit -= stakeUnit;
    }
  }
  const staked = bets * stakeUnit;
  return {
    bets,
    staked,
    profit,
    roi: staked > 0 ? profit / staked : 0,
    hitRate: bets > 0 ? hits / bets : null,
  };
}
