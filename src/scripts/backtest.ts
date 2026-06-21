/**
 * backtest.ts — deterministic, lookahead-safe calibration + value backtest.
 *
 *   bun run src/scripts/backtest.ts [leagueId] [season] [limit]
 *
 * For a COMPLETED season, derives an AS-OF-KICKOFF Poisson estimate for every
 * finished fixture using ONLY the matches that kicked off before it (no
 * lookahead — computeBaselineFromFixtures with date < kickoff), de-vigs the
 * historical odds, applies the shared value rule, and settles immediately
 * against the known outcome. Each row is stored as a CalibrationPrediction(+market)
 * in the SEPARATE calibration table (the betting chain and gate stay untouched).
 *
 * NO LLM: the agents add judgment, and after the determinism-boundary fix judgment
 * can no longer move the numbers — so probability calibration is fully determined
 * by the math. Running every fixture through six agents would burn tokens without
 * changing a single Brier contribution.
 *
 * Prints calibration (multiclass Brier / accuracy / base-rate skill) and a
 * flat-stake value P&L. The P&L is an HONEST CEILING: it applies the value rule
 * mechanically and omits the live Sharp/Risk vetoes that would remove some bets.
 */

import type { CalibrationPrediction } from "../lib/contracts.ts";
import {
  API_KEY,
  DEVIG_METHOD,
  LEAGUE_ID,
  SEASON,
  VALUE_THRESHOLD,
  buildVersionStamp,
} from "../lib/config.ts";
import { createApiClient } from "../lib/api-client.ts";
import { computeOneXTwo, computeValue } from "../lib/odds-math.ts";
import { computeBaselineFromFixtures } from "../lib/historical-baseline.ts";
import {
  accuracy,
  baseRateBrier,
  multiclassBrier,
  multiclassBrierOne,
  valueBacktest,
} from "../lib/calibration-metrics.ts";
import { CalibrationLog } from "../lib/calibration.ts";
import { CALIBRATION_DB_PATH } from "../lib/run-paths.ts";

if (API_KEY === "") {
  console.error(
    "API_FOOTBALL_KEY is empty — set it in .env before backtesting.",
  );
  process.exit(1);
}

const leagueId = Number(process.argv[2] ?? LEAGUE_ID);
const season = Number(process.argv[3] ?? SEASON);
const limitArg = process.argv[4];
const limit =
  limitArg !== undefined && limitArg !== "" ? Number(limitArg) : Infinity;

const api = createApiClient();
const log = new CalibrationLog(CALIBRATION_DB_PATH);
const createdAt = new Date().toISOString();

let processed = 0;
let warmupSkipped = 0;
let withOdds = 0;
const preds: CalibrationPrediction[] = [];

try {
  console.log(
    `backtest — league=${leagueId} season=${season} devig=${DEVIG_METHOD} threshold=${VALUE_THRESHOLD}`,
  );

  const results = await api.getLeagueSeasonResults(leagueId, season);
  if (results.length === 0) {
    console.error(
      `no finished fixtures for league ${leagueId} season ${season} — check the season is completed and your plan unlocks it (run capability.ts).`,
    );
    process.exit(1);
  }

  // Chronological order so "as-of" warmup grows naturally through the season.
  const ordered = [...results].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  for (const fx of ordered) {
    if (processed >= limit) break;

    const baseline = computeBaselineFromFixtures(
      results,
      fx.home.id,
      fx.away.id,
      fx.date,
    );
    if (baseline === null) {
      warmupSkipped++;
      continue; // insufficient prior matches — not a low-confidence guess, a skip
    }

    const math = computeOneXTwo(baseline);
    const actual = fx.outcome;
    const brier = multiclassBrierOne(math.probs, actual);

    // Historical odds are immutable → cached. Absent odds → calibration-only row.
    const odds = await api.getOdds(fx.fixtureId, { fresh: false });
    const market = odds
      ? computeValue(math.probs, odds.consensus, DEVIG_METHOD, VALUE_THRESHOLD)
      : undefined;
    if (market) withOdds++;

    const pred: CalibrationPrediction = {
      matchId: fx.fixtureId,
      league: String(leagueId),
      kickoff: fx.date,
      probs: math.probs,
      lambda: math.lambda,
      actualOutcome: actual,
      brier,
      market,
      mode: "validation",
      version: buildVersionStamp({
        createdAt,
        dataTimestamps: { asOf: fx.date },
      }),
      createdAt,
      settledAt: createdAt, // historical: settled at creation
    };

    log.insertCalibration(pred);
    preds.push(pred);
    processed++;

    if (processed % 50 === 0) console.log(`  …${processed} fixtures processed`);
  }
} finally {
  log.close();
}

// ── Summary (the same pure metric functions metrics.ts uses) ──────────────────
const brier = multiclassBrier(preds);
const base = baseRateBrier(preds);
const acc = accuracy(preds);
const pnl = valueBacktest(preds);

const fmt = (x: number | null, d = 4) => (x === null ? "n/a" : x.toFixed(d));
const pct = (x: number | null, d = 1) =>
  x === null ? "n/a" : `${(x * 100).toFixed(d)}%`;

console.log("\n=== Backtest summary ===");
console.log(
  `fixtures scored   : ${processed}  (warmup-skipped ${warmupSkipped}, with odds ${withOdds})`,
);
console.log(
  `multiclass Brier  : ${fmt(brier)}   (base-rate ${fmt(base)} — lower than base-rate = real skill)`,
);
console.log(`top-pick accuracy : ${pct(acc)}`);
console.log(`value bets        : ${pnl.bets}  hit ${pct(pnl.hitRate)}`);
console.log(
  `flat-stake P/L    : ${pnl.profit.toFixed(2)} u (staked ${pnl.staked.toFixed(2)} u)  ROI ${pct(pnl.roi)}`,
);
console.log(
  "\nNote: the value P/L is a CEILING — it omits the live Sharp/Risk vetoes.",
);
console.log(
  "Run `bun run src/scripts/metrics.ts` for the full reliability curve.",
);
