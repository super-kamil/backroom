/**
 * settle.ts — resolve every open prediction against the real match result.
 *
 *   bun src/scripts/settle.ts
 *
 * For each unsettled row, fetches the fixture result; if the match has resolved
 * to a 1X2 outcome, computes the binary-selection Brier contribution for BET
 * rows and records the settlement. Rows whose match has not finished are left
 * open for a later run. Requires the API key (it touches the network).
 *
 * Brier (per the calibration policy) scores the SELECTED outcome as a binary
 * event: (ourProb − [selection === actual])². Only well-formed BET rows with a
 * selection and an ourProb are scoreable; everything else settles with null.
 */

import type { Outcome } from "../lib/contracts.ts";
import { API_KEY } from "../lib/config.ts";
import { CalibrationLog } from "../lib/calibration.ts";
import { createApiClient } from "../lib/api-client.ts";
import { CALIBRATION_DB_PATH } from "../lib/run-paths.ts";

if (API_KEY === "") {
  console.error(
    "API_FOOTBALL_KEY is empty — set it in your environment to settle predictions.",
  );
  process.exit(1);
}

const log = new CalibrationLog(CALIBRATION_DB_PATH);
const api = createApiClient();

let settled = 0;
let unfinished = 0;

try {
  const open = log.getOpenPredictions();

  for (const row of open) {
    const actual = await api.getFixtureResult(row.matchId);
    if (actual === null) {
      unfinished++;
      continue;
    }

    const brier =
      row.recommendation === "BET" && row.selection && row.ourProb != null
        ? Math.pow(
            row.ourProb - ((row.selection as Outcome) === actual ? 1 : 0),
            2,
          )
        : null;

    log.settlePrediction(row.matchId, actual, brier, new Date().toISOString());
    settled++;
  }

  console.log(
    `settled ${settled} prediction(s); ${unfinished} still open/unfinished (of ${open.length} examined).`,
  );
} finally {
  log.close();
}
