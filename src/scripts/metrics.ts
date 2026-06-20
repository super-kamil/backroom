/**
 * metrics.ts — compute calibration / backtest metrics over the calibration log.
 *
 *   bun src/scripts/metrics.ts
 *
 * Two families, written into one data/metrics.json (the file /review-matchday
 * reads):
 *   - BETTING (settled PredictionRecord rows): binary-selection mean Brier,
 *     reliability curve, hit rate, flat-stake P/L. The live-chain bottom line.
 *   - VALIDATION (CalibrationPrediction rows from backtest.ts): full multiclass
 *     Brier vs the base-rate baseline, top-pick accuracy, the multiclass
 *     reliability curve, and the flat-stake value P/L (a ceiling — no Sharp/Risk
 *     vetoes). The honest "are the probabilities calibrated?" answer.
 */

import { mkdirSync } from "node:fs";

import { CalibrationLog } from "../lib/calibration.ts";
import {
  accuracy,
  baseRateBrier,
  hitRate,
  meanBrier,
  multiclassBrier,
  profitLossFlat,
  reliabilityBuckets,
  reliabilityMulticlass,
  valueBacktest,
} from "../lib/calibration-metrics.ts";
import { CALIBRATION_DB_PATH, DATA_DIR } from "../lib/run-paths.ts";

/** Format a number-or-null to fixed precision, or "n/a" when null. */
function fmt(x: number | null, digits = 4): string {
  return x === null ? "n/a" : x.toFixed(digits);
}

/** Format a 0..1 fraction as a percentage, or "n/a" when null. */
function pct(x: number | null, digits = 1): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(digits)}%`;
}

/** Print a predicted-vs-observed reliability table. */
function printReliability(
  buckets: Array<{ range: [number, number]; count: number; predictedAvg: number; observedFreq: number }>,
): void {
  console.log("  range          n   predicted  observed");
  for (const b of buckets) {
    const [lo, hi] = b.range;
    const range = `[${lo.toFixed(1)}, ${hi.toFixed(1)}]`.padEnd(12);
    const n = String(b.count).padStart(4);
    const predicted = pct(b.predictedAvg).padStart(9);
    const observed = pct(b.observedFreq).padStart(9);
    console.log(`  ${range} ${n}  ${predicted} ${observed}`);
  }
}

const log = new CalibrationLog(CALIBRATION_DB_PATH);

try {
  // ── BETTING (live-chain settled predictions) ─────────────────────────────────
  const records = log.getAllSettled();
  const betting = {
    recordCount: records.length,
    meanBrier: meanBrier(records),
    hitRate: hitRate(records),
    profitLossFlat: profitLossFlat(records),
    reliabilityBuckets: reliabilityBuckets(records),
  };

  // ── VALIDATION (backtest calibration predictions) ────────────────────────────
  const calib = log.getAllCalibration();
  const settledCalib = calib.filter((p) => p.actualOutcome !== null);
  const validation = {
    recordCount: calib.length,
    settledCount: settledCalib.length,
    multiclassBrier: multiclassBrier(calib),
    baseRateBrier: baseRateBrier(calib),
    accuracy: accuracy(calib),
    valueBacktest: valueBacktest(calib),
    reliabilityMulticlass: reliabilityMulticlass(calib),
  };

  const metrics = { generatedAt: new Date().toISOString(), betting, validation };

  // ── Readable report ──────────────────────────────────────────────────────────
  console.log("=== Betting metrics (live-chain settled predictions) ===");
  console.log(`settled records : ${betting.recordCount}`);
  console.log(`scoreable bets  : ${betting.profitLossFlat.bets}`);
  console.log(`mean Brier      : ${fmt(betting.meanBrier)}`);
  console.log(`hit rate        : ${pct(betting.hitRate)}`);
  console.log(
    `flat P/L        : ${betting.profitLossFlat.profit.toFixed(2)} u (staked ${betting.profitLossFlat.staked.toFixed(2)} u)`,
  );
  console.log(`ROI             : ${pct(betting.profitLossFlat.roi)}`);
  console.log("reliability (predicted vs observed, by ourProb bucket):");
  printReliability(betting.reliabilityBuckets);

  console.log("");
  console.log("=== Validation metrics (backtest calibration) ===");
  console.log(`calibration rows: ${validation.recordCount} (settled ${validation.settledCount})`);
  console.log(
    `multiclass Brier: ${fmt(validation.multiclassBrier)}  (base-rate ${fmt(validation.baseRateBrier)} — below base-rate = real skill)`,
  );
  console.log(`top-pick accuracy: ${pct(validation.accuracy)}`);
  console.log(
    `value P/L       : ${validation.valueBacktest.profit.toFixed(2)} u over ${validation.valueBacktest.bets} bets, ROI ${pct(validation.valueBacktest.roi)}, hit ${pct(validation.valueBacktest.hitRate)} (CEILING — no Sharp/Risk vetoes)`,
  );
  console.log("multiclass reliability (predicted vs observed, pooled 1X2):");
  printReliability(validation.reliabilityMulticlass);

  // ── Persist for the summarizer ───────────────────────────────────────────────
  mkdirSync(DATA_DIR, { recursive: true });
  await Bun.write("data/metrics.json", JSON.stringify(metrics, null, 2));
  console.log("");
  console.log("wrote data/metrics.json");
} finally {
  log.close();
}
