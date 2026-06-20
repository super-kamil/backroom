/**
 * log-prediction.ts — persist a Head Coach FinalDecision into the calibration log.
 *
 *   bun src/scripts/log-prediction.ts <fixtureId>
 *
 * Reads the run's decision.json, stamps it with a DETERMINISTIC PipelineVersion
 * (buildVersionStamp from config.ts — NOT the LLM's transcription), writes the
 * stamped decision back to disk, wraps it in a PredictionRecord (unsettled), and
 * upserts it into the bun:sqlite CalibrationLog so it can later be settled and
 * scored. Idempotent: re-running replaces the existing row for the same match.
 *
 * Why stamp here: the version stamp is calibration's attribution key — every
 * metric change must trace to a pipeline/prompt/threshold change. If the LLM
 * hand-transcribed it from config.ts it could silently drift from the real
 * config. Building it deterministically from the same constants the pipeline runs
 * on removes that failure mode entirely.
 */

import { mkdirSync } from "node:fs";

import type {
  FinalDecision,
  PredictionRecord,
  PrefetchBundle,
} from "../lib/contracts.ts";
import { buildVersionStamp } from "../lib/config.ts";
import { CalibrationLog } from "../lib/calibration.ts";
import { CALIBRATION_DB_PATH, DATA_DIR, runPath } from "../lib/run-paths.ts";

const fixtureId = process.argv[2];
if (!fixtureId) {
  console.error("usage: bun src/scripts/log-prediction.ts <fixtureId>");
  process.exit(1);
}

const decisionPath = runPath(fixtureId, "decision");
const decision = (await Bun.file(decisionPath).json()) as FinalDecision;

// Pull the real data timestamps from the prefetch bundle (best-effort: an absent
// prefetch only costs us the timestamps map, not the rest of the stamp).
let dataTimestamps: Record<string, string> = {};
try {
  const prefetch = (await Bun.file(runPath(fixtureId, "prefetch")).json()) as PrefetchBundle;
  dataTimestamps = prefetch.dataTimestamps ?? {};
} catch {
  dataTimestamps = {};
}

// DETERMINISTIC version stamp — overrides whatever (if anything) the agent wrote.
const createdAt = new Date().toISOString();
const version = buildVersionStamp({ createdAt, dataTimestamps });
decision.version = version;

// Write the stamped decision back so the on-disk artifact and the user-facing
// summary report the authoritative, deterministic version.
await Bun.write(decisionPath, JSON.stringify(decision, null, 2));

const record: PredictionRecord = {
  matchId: decision.matchId,
  league: decision.fixture.league.name,
  kickoff: decision.fixture.date,
  createdAt,
  decision,
  actualOutcome: null,
  brier: null,
  settledAt: null,
};

// Ensure data/ exists before opening the sqlite file.
mkdirSync(DATA_DIR, { recursive: true });

const log = new CalibrationLog(CALIBRATION_DB_PATH);
try {
  log.insertPrediction(record);
} finally {
  log.close();
}

const sel = decision.selection ? ` ${decision.selection}` : "";
console.log(
  `logged prediction for match ${record.matchId} (${record.league}): ${decision.recommendation}${sel} [${version.pipelineVersion}]`,
);
