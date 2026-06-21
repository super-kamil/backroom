/**
 * calibration.ts — the bun:sqlite store for PredictionRecord (see contracts.ts).
 *
 * One row per match. Queryable columns are denormalized out of the FinalDecision
 * for cheap filtering/reporting; the full FinalDecision is preserved verbatim in
 * decisionJson so getAllSettled can hand pure metrics functions the real shape.
 *
 * Lifecycle: insertPrediction (at decision time) → settlePrediction (after the
 * match resolves) → getAllSettled (feeds calibration-metrics.ts).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  CalibrationPrediction,
  FinalDecision,
  Outcome,
  PredictionRecord,
} from "./contracts.ts";

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS predictions (
  matchId INTEGER PRIMARY KEY,
  league TEXT,
  kickoff TEXT,
  createdAt TEXT,
  settledAt TEXT,
  actualOutcome TEXT,
  brier REAL,
  recommendation TEXT,
  selection TEXT,
  ourProb REAL,
  fairProb REAL,
  edge REAL,
  odds REAL,
  stake REAL,
  ev REAL,
  pipelineVersion TEXT,
  deVigMethod TEXT,
  valueThreshold REAL,
  decisionJson TEXT NOT NULL
)`;

// Validation-mode store. SEPARATE table from `predictions` (the betting chain) so
// the betting log and Data Quality Gate stay untouched. The probability calibration
// is the odds-free core; no odds COLUMNS here — the optional `market` block (de-vig
// + value, when historical odds were fetched) rides inside `predictionJson`.
const CREATE_CALIBRATION_TABLE = `
CREATE TABLE IF NOT EXISTS calibration_predictions (
  matchId INTEGER PRIMARY KEY,
  league TEXT,
  kickoff TEXT,
  createdAt TEXT,
  settledAt TEXT,
  probHome REAL,
  probDraw REAL,
  probAway REAL,
  lambdaHome REAL,
  lambdaAway REAL,
  actualOutcome TEXT,
  brier REAL,
  mode TEXT,
  pipelineVersion TEXT,
  mathVersion TEXT,
  predictionJson TEXT NOT NULL
)`;

/** Defensive accessor: bun:sqlite returns rows as Record<string, unknown>-ish. */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export class CalibrationLog {
  private readonly db: Database;

  constructor(dbPath: string) {
    // bun:sqlite will not create the parent directory; ensure it exists first
    // (skip the in-memory sentinel used by tests).
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(CREATE_TABLE);
    this.db.run(CREATE_CALIBRATION_TABLE);
  }

  /**
   * UPSERT by matchId. The full FinalDecision is JSON-encoded into decisionJson;
   * the queryable columns are extracted from record.decision. Idempotent: a
   * second insert for the same matchId replaces the single existing row.
   */
  insertPrediction(record: PredictionRecord): void {
    const d = record.decision;
    const v = d.version;
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO predictions (
        matchId, league, kickoff, createdAt, settledAt, actualOutcome, brier,
        recommendation, selection, ourProb, fairProb, edge, odds, stake, ev,
        pipelineVersion, deVigMethod, valueThreshold, decisionJson
      ) VALUES (
        $matchId, $league, $kickoff, $createdAt, $settledAt, $actualOutcome, $brier,
        $recommendation, $selection, $ourProb, $fairProb, $edge, $odds, $stake, $ev,
        $pipelineVersion, $deVigMethod, $valueThreshold, $decisionJson
      )`);
    stmt.run({
      $matchId: record.matchId,
      $league: record.league,
      $kickoff: record.kickoff,
      $createdAt: record.createdAt,
      $settledAt: record.settledAt,
      $actualOutcome: record.actualOutcome,
      $brier: record.brier,
      $recommendation: d.recommendation,
      $selection: d.selection,
      $ourProb: d.ourProb,
      $fairProb: d.fairProb,
      $edge: d.edge,
      $odds: d.odds,
      $stake: d.stake,
      $ev: d.ev,
      $pipelineVersion: v.pipelineVersion,
      $deVigMethod: v.deVigMethod,
      $valueThreshold: v.valueThreshold,
      $decisionJson: JSON.stringify(d),
    });
  }

  /** Rows not yet settled — what `settle` iterates over. */
  getOpenPredictions(): Array<{
    matchId: number;
    league: string;
    kickoff: string;
    recommendation: string;
    selection: string | null;
    ourProb: number | null;
  }> {
    const rows = this.db
      .query(
        `SELECT matchId, league, kickoff, recommendation, selection, ourProb
         FROM predictions WHERE settledAt IS NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      matchId: asNumber(r["matchId"]),
      league: asString(r["league"]),
      kickoff: asString(r["kickoff"]),
      recommendation: asString(r["recommendation"]),
      selection: asStringOrNull(r["selection"]),
      ourProb: asNumberOrNull(r["ourProb"]),
    }));
  }

  /** Record the resolved outcome + Brier contribution for one match. */
  settlePrediction(
    matchId: number,
    actualOutcome: Outcome,
    brier: number | null,
    settledAt: string,
  ): void {
    this.db
      .query(
        `UPDATE predictions
         SET actualOutcome = $actualOutcome, brier = $brier, settledAt = $settledAt
         WHERE matchId = $matchId`,
      )
      .run({
        $actualOutcome: actualOutcome,
        $brier: brier,
        $settledAt: settledAt,
        $matchId: matchId,
      });
  }

  /** Settled rows, with decisionJson parsed back into a FinalDecision. */
  getAllSettled(): Array<{
    matchId: number;
    decision: FinalDecision;
    actualOutcome: Outcome | null;
    brier: number | null;
  }> {
    const rows = this.db
      .query(
        `SELECT matchId, actualOutcome, brier, decisionJson
         FROM predictions WHERE settledAt IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      matchId: asNumber(r["matchId"]),
      decision: JSON.parse(asString(r["decisionJson"])) as FinalDecision,
      actualOutcome: asStringOrNull(r["actualOutcome"]) as Outcome | null,
      brier: asNumberOrNull(r["brier"]),
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Validation mode — calibration_predictions (odds-free core + optional market)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * UPSERT by matchId into the SEPARATE calibration_predictions table. The whole
   * CalibrationPrediction is JSON-encoded into predictionJson; the queryable
   * columns are denormalized out of p.probs / p.lambda / p.version. Idempotent: a
   * second insert for the same matchId replaces the single existing row. This path
   * never touches the betting `predictions` table.
   */
  insertCalibration(p: CalibrationPrediction): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO calibration_predictions (
        matchId, league, kickoff, createdAt, settledAt,
        probHome, probDraw, probAway, lambdaHome, lambdaAway,
        actualOutcome, brier, mode, pipelineVersion, mathVersion, predictionJson
      ) VALUES (
        $matchId, $league, $kickoff, $createdAt, $settledAt,
        $probHome, $probDraw, $probAway, $lambdaHome, $lambdaAway,
        $actualOutcome, $brier, $mode, $pipelineVersion, $mathVersion, $predictionJson
      )`);
    stmt.run({
      $matchId: p.matchId,
      $league: p.league,
      $kickoff: p.kickoff,
      $createdAt: p.createdAt,
      $settledAt: p.settledAt,
      $probHome: p.probs.home,
      $probDraw: p.probs.draw,
      $probAway: p.probs.away,
      $lambdaHome: p.lambda.home,
      $lambdaAway: p.lambda.away,
      $actualOutcome: p.actualOutcome,
      $brier: p.brier,
      $mode: p.mode,
      $pipelineVersion: p.version.pipelineVersion,
      $mathVersion: p.version.mathVersion,
      $predictionJson: JSON.stringify(p),
    });
  }

  /**
   * All calibration rows, with predictionJson parsed back defensively. The
   * authoritative settle columns (actualOutcome/brier/settledAt) are overlaid on
   * the parsed object so rows settled via settleCalibration (which only updates
   * the columns) reflect the resolved state.
   */
  getAllCalibration(): CalibrationPrediction[] {
    const rows = this.db
      .query(
        `SELECT actualOutcome, brier, settledAt, predictionJson FROM calibration_predictions`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const p = JSON.parse(
        asString(r["predictionJson"]),
      ) as CalibrationPrediction;
      return {
        ...p,
        actualOutcome: asStringOrNull(r["actualOutcome"]) as Outcome | null,
        brier: asNumberOrNull(r["brier"]),
        settledAt: asStringOrNull(r["settledAt"]),
      };
    });
  }

  /** Calibration rows not yet settled — for future live validation. */
  getOpenCalibration(): CalibrationPrediction[] {
    const rows = this.db
      .query(
        `SELECT predictionJson FROM calibration_predictions WHERE settledAt IS NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(
      (r) => JSON.parse(asString(r["predictionJson"])) as CalibrationPrediction,
    );
  }

  /** Record the resolved outcome + Brier contribution for one calibration row. */
  settleCalibration(
    matchId: number,
    actualOutcome: Outcome,
    brier: number | null,
    settledAt: string,
  ): void {
    this.db
      .query(
        `UPDATE calibration_predictions
         SET actualOutcome = $actualOutcome, brier = $brier, settledAt = $settledAt
         WHERE matchId = $matchId`,
      )
      .run({
        $actualOutcome: actualOutcome,
        $brier: brier,
        $settledAt: settledAt,
        $matchId: matchId,
      });
  }

  close(): void {
    this.db.close();
  }
}
