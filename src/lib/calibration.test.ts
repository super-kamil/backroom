import { describe, expect, test } from "bun:test";

import { CalibrationLog } from "./calibration.ts";
import type {
  CalibrationPrediction,
  FinalDecision,
  FixtureRef,
  PipelineVersion,
  PredictionRecord,
} from "./contracts.ts";

function fixture(id: number): FixtureRef {
  return {
    id,
    league: { id: 39, name: "Premier League", season: 2025 },
    date: "2026-06-20T15:00:00Z",
    venue: "Stadium",
    status: "NS",
    home: { id: 1, name: "Home FC" },
    away: { id: 2, name: "Away FC" },
  };
}

function version(): PipelineVersion {
  return {
    pipelineVersion: "mvp-thin-chain-0.1.0",
    agentPromptVersions: {},
    modelAssignments: {},
    mathVersion: "poisson-1x2-0.1.0",
    dataProvider: "api-football-v3",
    deVigMethod: "proportional",
    valueThreshold: 0.05,
    createdAt: "2026-06-19T00:00:00Z",
    dataTimestamps: {},
  };
}

function decision(matchId: number, overrides: Partial<FinalDecision> = {}): FinalDecision {
  return {
    matchId,
    fixture: fixture(matchId),
    recommendation: "BET",
    selection: "home",
    ourProb: 0.6,
    fairProb: 0.5,
    edge: 0.1,
    odds: 2.0,
    ev: 0.2,
    stake: 20,
    confidence: "medium",
    rationale: "value on home",
    dissent: { sharpVerdict: "agree", divergence: "none" },
    dataQuality: {
      gate: "pass",
      checks: {
        oddsAvailable: true,
        sufficientHomeForm: true,
        sufficientAwayForm: true,
        baselineAvailable: true,
        coverageChecked: true,
      },
      missing: [],
      inputConfidence: "high",
      reason: "ok",
    },
    version: version(),
    ...overrides,
  };
}

function record(matchId: number, overrides: Partial<FinalDecision> = {}): PredictionRecord {
  const d = decision(matchId, overrides);
  return {
    matchId,
    league: d.fixture.league.name,
    kickoff: d.fixture.date,
    decision: d,
    actualOutcome: null,
    brier: null,
    settledAt: null,
    createdAt: "2026-06-19T00:00:00Z",
  };
}

function calibration(
  matchId: number,
  overrides: Partial<CalibrationPrediction> = {},
): CalibrationPrediction {
  return {
    matchId,
    league: "Premier League",
    kickoff: "2024-05-19T15:00:00Z",
    probs: { home: 0.55, draw: 0.25, away: 0.2 },
    lambda: { home: 1.8, away: 0.9 },
    actualOutcome: null,
    brier: null,
    mode: "validation",
    version: version(),
    createdAt: "2024-05-19T10:00:00Z",
    settledAt: null,
    ...overrides,
  };
}

describe("CalibrationLog", () => {
  test("insert then getOpenPredictions returns the row", () => {
    const log = new CalibrationLog(":memory:");
    log.insertPrediction(record(100));

    const open = log.getOpenPredictions();
    expect(open).toHaveLength(1);
    expect(open[0]).toBeDefined();
    expect(open[0]!.matchId).toBe(100);
    expect(open[0]!.league).toBe("Premier League");
    expect(open[0]!.recommendation).toBe("BET");
    expect(open[0]!.selection).toBe("home");
    expect(open[0]!.ourProb).toBeCloseTo(0.6, 10);
    log.close();
  });

  test("settle then getAllSettled returns outcome, brier and parsed decision", () => {
    const log = new CalibrationLog(":memory:");
    log.insertPrediction(record(101));

    // Before settling, it is open and not in getAllSettled.
    expect(log.getOpenPredictions()).toHaveLength(1);
    expect(log.getAllSettled()).toHaveLength(0);

    log.settlePrediction(101, "home", 0.16, "2026-06-21T17:00:00Z");

    expect(log.getOpenPredictions()).toHaveLength(0);
    const settled = log.getAllSettled();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBeDefined();
    expect(settled[0]!.matchId).toBe(101);
    expect(settled[0]!.actualOutcome).toBe("home");
    expect(settled[0]!.brier).toBeCloseTo(0.16, 10);
    // decisionJson round-trips into a FinalDecision.
    expect(settled[0]!.decision.recommendation).toBe("BET");
    expect(settled[0]!.decision.selection).toBe("home");
    expect(settled[0]!.decision.odds).toBeCloseTo(2.0, 10);
    expect(settled[0]!.decision.version.pipelineVersion).toBe("mvp-thin-chain-0.1.0");
    log.close();
  });

  test("inserting the same matchId twice keeps a single row (idempotent UPSERT)", () => {
    const log = new CalibrationLog(":memory:");
    log.insertPrediction(record(102, { ourProb: 0.6, edge: 0.1 }));
    // Re-insert same matchId with changed fields.
    log.insertPrediction(record(102, { ourProb: 0.7, edge: 0.2, selection: "away" }));

    const open = log.getOpenPredictions();
    expect(open).toHaveLength(1);
    expect(open[0]).toBeDefined();
    // Latest write wins.
    expect(open[0]!.ourProb).toBeCloseTo(0.7, 10);
    expect(open[0]!.selection).toBe("away");
    log.close();
  });

  test("settle persists across the queryable columns and JSON consistently", () => {
    const log = new CalibrationLog(":memory:");
    log.insertPrediction(record(103, { recommendation: "NO-BET", selection: null, ourProb: null }));

    const open = log.getOpenPredictions();
    expect(open[0]).toBeDefined();
    expect(open[0]!.recommendation).toBe("NO-BET");
    expect(open[0]!.selection).toBeNull();
    expect(open[0]!.ourProb).toBeNull();
    log.close();
  });
});

describe("CalibrationLog — validation (calibration_predictions) table", () => {
  function market(): NonNullable<CalibrationPrediction["market"]> {
    return {
      rawOdds: { home: 1.8, draw: 3.6, away: 4.5 },
      impliedRaw: { home: 0.5556, draw: 0.2778, away: 0.2222 },
      overround: 0.0556,
      deVigMethod: "proportional",
      fairProbs: { home: 0.52, draw: 0.27, away: 0.21 },
      value: {
        home: { ourProb: 0.55, fairProb: 0.52, edge: 0.03, hasValue: false },
        draw: { ourProb: 0.25, fairProb: 0.27, edge: -0.02, hasValue: false },
        away: { ourProb: 0.2, fairProb: 0.21, edge: -0.01, hasValue: false },
      },
      bestSelection: "home",
      valueThreshold: 0.05,
    };
  }

  test("insertCalibration round-trips probs/lambda + the optional market block", () => {
    const log = new CalibrationLog(":memory:");
    log.insertCalibration(
      calibration(200, {
        actualOutcome: "home",
        brier: 0.3,
        settledAt: "2024-05-20T18:00:00Z",
        market: market(),
      }),
    );

    const all = log.getAllCalibration();
    expect(all).toHaveLength(1);
    expect(all[0]!.matchId).toBe(200);
    expect(all[0]!.probs.home).toBeCloseTo(0.55, 10);
    expect(all[0]!.lambda.home).toBeCloseTo(1.8, 10);
    // Settle columns overlay onto the parsed JSON.
    expect(all[0]!.actualOutcome).toBe("home");
    expect(all[0]!.brier).toBeCloseTo(0.3, 10);
    expect(all[0]!.settledAt).toBe("2024-05-20T18:00:00Z");
    // The market block survives the JSON round-trip.
    expect(all[0]!.market?.bestSelection).toBe("home");
    expect(all[0]!.market?.rawOdds.home).toBeCloseTo(1.8, 10);
    log.close();
  });

  test("a calibration-only row (no odds) round-trips with market undefined", () => {
    const log = new CalibrationLog(":memory:");
    log.insertCalibration(calibration(201, { actualOutcome: "draw", brier: 0.4 }));
    const all = log.getAllCalibration();
    expect(all).toHaveLength(1);
    expect(all[0]!.market).toBeUndefined();
    log.close();
  });

  test("calibration rows are separate from the betting predictions table", () => {
    const log = new CalibrationLog(":memory:");
    log.insertPrediction(record(300));
    log.insertCalibration(calibration(300));
    // Same matchId in BOTH tables, but each query sees only its own table.
    expect(log.getOpenPredictions()).toHaveLength(1);
    expect(log.getAllCalibration()).toHaveLength(1);
    log.close();
  });
});
