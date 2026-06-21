/**
 * backtest-pipeline.test.ts — composition test for the deterministic backtest.
 *
 * backtest.ts wires several libs together per fixture: as-of baseline → Poisson →
 * multiclass Brier → de-vig/value → store. Each piece is unit-tested elsewhere;
 * this proves they COMPOSE correctly, and — the load-bearing claim — that the
 * composed estimate for a fixture is BYTE-IDENTICAL whether you feed it the whole
 * season or only the matches before kickoff. If future results could leak in, this
 * test fails. Run with `bun test`.
 */

import { test, expect, describe } from "bun:test";
import type {
  CalibrationPrediction,
  MatchResult,
  OutcomeOdds,
  PipelineVersion,
} from "./contracts.ts";
import { computeBaselineFromFixtures } from "./historical-baseline.ts";
import { computeOneXTwo, computeValue } from "./odds-math.ts";
import {
  multiclassBrier,
  multiclassBrierOne,
  valueBacktest,
} from "./calibration-metrics.ts";
import { CalibrationLog } from "./calibration.ts";

function mr(
  id: number,
  date: string,
  home: number,
  away: number,
  gh: number,
  ga: number,
): MatchResult {
  return {
    fixtureId: id,
    date,
    home: { id: home, name: `T${home}` },
    away: { id: away, name: `T${away}` },
    goalsHome: gh,
    goalsAway: ga,
    outcome: gh > ga ? "home" : gh < ga ? "away" : "draw",
    status: "FT",
  };
}

function ver(): PipelineVersion {
  return {
    pipelineVersion: "mvp-thin-chain-0.1.0",
    agentPromptVersions: {},
    modelAssignments: {},
    mathVersion: "poisson-1x2-0.1.0",
    dataProvider: "api-football-v3",
    deVigMethod: "proportional",
    valueThreshold: 0.05,
    createdAt: "2024-03-01T00:00:00Z",
    dataTimestamps: {},
  };
}

/** The exact per-fixture pipeline backtest.ts runs (minus the network/store). */
function pipelineFor(
  results: MatchResult[],
  fx: MatchResult,
  consensus: OutcomeOdds,
): CalibrationPrediction | null {
  const baseline = computeBaselineFromFixtures(
    results,
    fx.home.id,
    fx.away.id,
    fx.date,
  );
  if (baseline === null) return null;
  const math = computeOneXTwo(baseline);
  const market = computeValue(math.probs, consensus, "proportional", 0.05);
  return {
    matchId: fx.fixtureId,
    league: "L",
    kickoff: fx.date,
    probs: math.probs,
    lambda: math.lambda,
    actualOutcome: fx.outcome,
    brier: multiclassBrierOne(math.probs, fx.outcome),
    market,
    mode: "validation",
    version: ver(),
    createdAt: "2024-06-01T00:00:00Z",
    settledAt: "2024-06-01T00:00:00Z",
  };
}

// Teams 1 (home) and 2 (away) each get 3 qualifying prior matches before the
// target fixture F (f7 on 2024-03-01). f8–f10 are AFTER it (blowouts) and must
// never influence F's estimate.
const PRIOR: MatchResult[] = [
  mr(101, "2024-01-01T15:00:00+00:00", 1, 3, 2, 0),
  mr(102, "2024-01-08T15:00:00+00:00", 1, 4, 1, 1),
  mr(103, "2024-02-01T15:00:00+00:00", 1, 5, 3, 1),
  mr(104, "2024-01-05T15:00:00+00:00", 6, 2, 0, 1),
  mr(105, "2024-01-12T15:00:00+00:00", 7, 2, 2, 2),
  mr(106, "2024-02-05T15:00:00+00:00", 8, 2, 1, 0),
];
const TARGET = mr(107, "2024-03-01T15:00:00+00:00", 1, 2, 2, 1); // outcome home
const FUTURE: MatchResult[] = [
  mr(108, "2024-03-15T15:00:00+00:00", 1, 2, 9, 0),
  mr(109, "2024-04-01T15:00:00+00:00", 6, 2, 9, 0),
  mr(110, "2024-03-20T15:00:00+00:00", 1, 9, 9, 0),
];

const ODDS: OutcomeOdds = { home: 1.8, draw: 3.6, away: 4.8 };

describe("backtest pipeline composition", () => {
  test("the estimate is identical with or without future matches (no lookahead)", () => {
    const full = pipelineFor([...PRIOR, TARGET, ...FUTURE], TARGET, ODDS);
    const priorOnly = pipelineFor(PRIOR, TARGET, ODDS);
    expect(full).not.toBeNull();
    expect(priorOnly).not.toBeNull();
    // Probabilities, lambda and Brier are byte-identical — the cutoff makes every
    // later (and the match's own) result irrelevant.
    expect(full!.probs).toEqual(priorOnly!.probs);
    expect(full!.lambda).toEqual(priorOnly!.lambda);
    expect(full!.brier).toBeCloseTo(priorOnly!.brier!, 12);
  });

  test("produces a sane, complete CalibrationPrediction with a market block", () => {
    const p = pipelineFor(PRIOR, TARGET, ODDS)!;
    expect(p.probs.home + p.probs.draw + p.probs.away).toBeCloseTo(1, 10);
    expect(p.brier).toBeGreaterThanOrEqual(0);
    expect(p.brier).toBeLessThanOrEqual(2);
    expect(p.market).toBeDefined();
    // The de-vig identity survives composition.
    for (const o of ["home", "draw", "away"] as const) {
      expect(p.market!.value[o].edge).toBeCloseTo(
        p.market!.value[o].ourProb - p.market!.value[o].fairProb,
        12,
      );
    }
  });

  test("a fixture with too little warmup is skipped (null), not guessed", () => {
    // Only 2 prior home matches for team 1 → below MIN_PRIOR_MATCHES.
    const thin = PRIOR.filter((m) => m.fixtureId !== 103);
    expect(pipelineFor(thin, TARGET, ODDS)).toBeNull();
  });

  test("stored rows round-trip and feed the validation metrics", () => {
    const log = new CalibrationLog(":memory:");
    const p = pipelineFor(PRIOR, TARGET, ODDS)!;
    log.insertCalibration(p);

    const all = log.getAllCalibration();
    expect(all).toHaveLength(1);
    expect(all[0]!.market?.bestSelection).toBe(p.market!.bestSelection);

    // Metrics run over the stored rows without throwing and agree with the row.
    expect(multiclassBrier(all)).toBeCloseTo(p.brier!, 10);
    const pnl = valueBacktest(all);
    const expectBets = p.market!.bestSelection === null ? 0 : 1;
    expect(pnl.bets).toBe(expectBets);
    log.close();
  });
});
