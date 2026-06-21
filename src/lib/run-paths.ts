/**
 * run-paths.ts — the per-match run-directory conventions every script and the
 * orchestrating skill agree on. The skill prefetches, then dispatches subagents
 * that read their slice and write their report into the same run directory.
 *
 *   runs/<fixtureId>/
 *     prefetch.json     ← deterministic prefetch bundle (PrefetchBundle)
 *     gate.json         ← Data Quality Gate result (DataQualityResult)
 *     form-scout.json   ← FormScoutReport
 *     quant-math.json   ← deterministic Poisson output (QuantMath, from compute.ts)
 *     quant.json        ← QuantReport
 *     trader-math.json  ← deterministic de-vig + value (from devig.ts)
 *     trader.json       ← TraderReport
 *     risk-math.json    ← deterministic stake sizing (from stake.ts)
 *     risk.json         ← RiskReport
 *     sharp.json        ← SharpReport
 *     decision.json     ← FinalDecision
 *
 * Determinism boundary: the *-math.json files are written by deterministic
 * scripts (pure arithmetic). The agent then reads its *-math.json, adds
 * qualitative judgment, and writes its report (quant/trader/risk).json.
 */

import { join } from "node:path";

export const DATA_DIR = "data";
export const RUNS_DIR = "runs";

/** SQLite files (cache + calibration log) live under data/. */
export const CACHE_DB_PATH = join(DATA_DIR, "cache.sqlite");
export const CALIBRATION_DB_PATH = join(DATA_DIR, "calibration.sqlite");

export function runDir(fixtureId: number | string): string {
  return join(RUNS_DIR, String(fixtureId));
}

export type RunArtifact =
  | "prefetch"
  | "gate"
  | "form-scout"
  | "quant-math"
  | "quant"
  | "trader-math"
  | "trader"
  | "risk-math"
  | "risk"
  | "sharp"
  | "decision";

export function runPath(
  fixtureId: number | string,
  artifact: RunArtifact,
): string {
  return join(runDir(fixtureId), `${artifact}.json`);
}
