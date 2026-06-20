import { describe, expect, test } from "bun:test";

import {
  accuracy,
  baseRateBrier,
  brierForPrediction,
  hitRate,
  meanBrier,
  multiclassBrier,
  multiclassBrierOne,
  profitLossFlat,
  reliabilityBuckets,
  reliabilityMulticlass,
  valueBacktest,
  type SettledRecord,
} from "./calibration-metrics.ts";
import type {
  CalibrationPrediction,
  Outcome,
  OutcomeProbs,
  PipelineVersion,
  FinalDecision,
} from "./contracts.ts";

/**
 * Build a minimal SettledRecord. The metrics only read
 * decision.recommendation / selection / ourProb / odds and actualOutcome, so we
 * cast a partial FinalDecision through unknown to keep fixtures terse.
 */
function rec(args: {
  recommendation?: "BET" | "NO-BET";
  selection?: Outcome | null;
  ourProb?: number | null;
  odds?: number | null;
  actualOutcome: Outcome | null;
}): SettledRecord {
  const decision = {
    recommendation: args.recommendation ?? "BET",
    selection: args.selection ?? "home",
    ourProb: args.ourProb ?? 0.5,
    odds: args.odds ?? 2.0,
  } as unknown as FinalDecision;
  return { decision, actualOutcome: args.actualOutcome };
}

describe("brierForPrediction", () => {
  test("perfect confident correct call scores 0", () => {
    expect(brierForPrediction(1, true)).toBe(0);
  });
  test("perfect confident wrong call scores 1", () => {
    expect(brierForPrediction(1, false)).toBe(1);
  });
  test("a coin-flip scores 0.25 either way", () => {
    expect(brierForPrediction(0.5, true)).toBeCloseTo(0.25, 10);
    expect(brierForPrediction(0.5, false)).toBeCloseTo(0.25, 10);
  });
  test("(0.7 hit) = 0.09", () => {
    expect(brierForPrediction(0.7, true)).toBeCloseTo(0.09, 10);
  });
});

describe("meanBrier", () => {
  test("null when there are no BET records", () => {
    expect(meanBrier([])).toBeNull();
    expect(
      meanBrier([rec({ recommendation: "NO-BET", actualOutcome: "home" })]),
    ).toBeNull();
  });

  test("a well-calibrated / mostly-correct set has LOW mean Brier", () => {
    // High-confidence calls that mostly land.
    const records: SettledRecord[] = [
      rec({ ourProb: 0.9, selection: "home", actualOutcome: "home" }),
      rec({ ourProb: 0.9, selection: "home", actualOutcome: "home" }),
      rec({ ourProb: 0.85, selection: "away", actualOutcome: "away" }),
      rec({ ourProb: 0.88, selection: "draw", actualOutcome: "draw" }),
    ];
    const mb = meanBrier(records);
    expect(mb).not.toBeNull();
    expect(mb!).toBeLessThan(0.05);
  });

  test("an always-wrong confident set has HIGH mean Brier", () => {
    const records: SettledRecord[] = [
      rec({ ourProb: 0.95, selection: "home", actualOutcome: "away" }),
      rec({ ourProb: 0.95, selection: "home", actualOutcome: "draw" }),
      rec({ ourProb: 0.9, selection: "away", actualOutcome: "home" }),
    ];
    const mb = meanBrier(records);
    expect(mb).not.toBeNull();
    expect(mb!).toBeGreaterThan(0.8);
  });

  test("ignores NO-BET rows when averaging", () => {
    const records: SettledRecord[] = [
      rec({ ourProb: 0.7, selection: "home", actualOutcome: "home" }), // brier 0.09
      rec({ recommendation: "NO-BET", actualOutcome: "away" }), // ignored
    ];
    expect(meanBrier(records)!).toBeCloseTo(0.09, 10);
  });
});

describe("hitRate", () => {
  test("null when no BET records", () => {
    expect(hitRate([])).toBeNull();
  });

  test("counts selection-vs-actual matches as a fraction", () => {
    const records: SettledRecord[] = [
      rec({ selection: "home", actualOutcome: "home" }), // hit
      rec({ selection: "away", actualOutcome: "home" }), // miss
      rec({ selection: "draw", actualOutcome: "draw" }), // hit
      rec({ selection: "home", actualOutcome: "draw" }), // miss
    ];
    expect(hitRate(records)!).toBeCloseTo(0.5, 10);
  });

  test("excludes NO-BET rows from the denominator", () => {
    const records: SettledRecord[] = [
      rec({ selection: "home", actualOutcome: "home" }), // hit
      rec({ recommendation: "NO-BET", actualOutcome: "home" }), // ignored
    ];
    expect(hitRate(records)!).toBeCloseTo(1.0, 10);
  });
});

describe("profitLossFlat", () => {
  test("one win at odds 2.0 and one loss nets exactly 0 on 1u flat stakes", () => {
    const records: SettledRecord[] = [
      rec({ selection: "home", odds: 2.0, actualOutcome: "home" }), // win: +1.0
      rec({ selection: "away", odds: 2.0, actualOutcome: "home" }), // loss: −1.0
    ];
    const pl = profitLossFlat(records, 1);
    expect(pl.bets).toBe(2);
    expect(pl.staked).toBe(2);
    expect(pl.profit).toBeCloseTo(0, 10);
    expect(pl.roi).toBeCloseTo(0, 10);
  });

  test("hand-checkable: win at 3.0 and loss at 2.0 → +2 −1 = +1, roi 0.5", () => {
    const records: SettledRecord[] = [
      rec({ selection: "home", odds: 3.0, actualOutcome: "home" }), // win: +2.0
      rec({ selection: "away", odds: 2.0, actualOutcome: "home" }), // loss: −1.0
    ];
    const pl = profitLossFlat(records, 1);
    expect(pl.bets).toBe(2);
    expect(pl.staked).toBe(2);
    expect(pl.profit).toBeCloseTo(1, 10);
    expect(pl.roi).toBeCloseTo(0.5, 10);
  });

  test("respects stakeUnit scaling", () => {
    const records: SettledRecord[] = [
      rec({ selection: "home", odds: 2.5, actualOutcome: "home" }), // win: (2.5-1)*10 = 15
    ];
    const pl = profitLossFlat(records, 10);
    expect(pl.bets).toBe(1);
    expect(pl.staked).toBe(10);
    expect(pl.profit).toBeCloseTo(15, 10);
    expect(pl.roi).toBeCloseTo(1.5, 10);
  });

  test("ignores NO-BET rows and zero-bet case is safe", () => {
    const pl = profitLossFlat(
      [rec({ recommendation: "NO-BET", actualOutcome: "home" })],
      1,
    );
    expect(pl.bets).toBe(0);
    expect(pl.staked).toBe(0);
    expect(pl.profit).toBe(0);
    expect(pl.roi).toBe(0);
  });
});

describe("reliabilityBuckets", () => {
  test("default produces 10 equal-width buckets spanning [0,1]", () => {
    const buckets = reliabilityBuckets([]);
    expect(buckets).toHaveLength(10);
    expect(buckets[0]!.range[0]).toBeCloseTo(0, 10);
    expect(buckets[0]!.range[1]).toBeCloseTo(0.1, 10);
    expect(buckets[9]!.range[0]).toBeCloseTo(0.9, 10);
    expect(buckets[9]!.range[1]).toBeCloseTo(1.0, 10);
    // Empty set: all counts zero.
    for (const b of buckets) {
      expect(b.count).toBe(0);
      expect(b.observedFreq).toBe(0);
      expect(b.predictedAvg).toBe(0);
    }
  });

  test("assigns records to the right decile with correct observed frequency", () => {
    // Three records around 0.7: two hits, one miss → bucket [0.7,0.8) observed 2/3.
    const records: SettledRecord[] = [
      rec({ ourProb: 0.72, selection: "home", actualOutcome: "home" }),
      rec({ ourProb: 0.75, selection: "home", actualOutcome: "home" }),
      rec({ ourProb: 0.78, selection: "home", actualOutcome: "away" }),
    ];
    const buckets = reliabilityBuckets(records, 10);
    const b = buckets[7]!; // [0.7, 0.8)
    expect(b.range[0]).toBeCloseTo(0.7, 10);
    expect(b.count).toBe(3);
    expect(b.predictedAvg).toBeCloseTo((0.72 + 0.75 + 0.78) / 3, 10);
    expect(b.observedFreq).toBeCloseTo(2 / 3, 10);
    // Every other bucket is empty.
    const others = buckets.filter((_, i) => i !== 7);
    expect(others.every((x) => x.count === 0)).toBe(true);
  });

  test("ourProb === 1 lands in the top bucket", () => {
    const records: SettledRecord[] = [
      rec({ ourProb: 1, selection: "home", actualOutcome: "home" }),
    ];
    const buckets = reliabilityBuckets(records, 10);
    expect(buckets[9]!.count).toBe(1);
    expect(buckets[9]!.observedFreq).toBeCloseTo(1, 10);
  });

  test("honours a custom bucket count", () => {
    const buckets = reliabilityBuckets([], 4);
    expect(buckets).toHaveLength(4);
    expect(buckets[0]!.range).toEqual([0, 0.25]);
    expect(buckets[3]!.range[1]).toBeCloseTo(1, 10);
  });

  test("a well-calibrated set tracks the diagonal (predictedAvg ≈ observedFreq)", () => {
    // Bucket [0.5,0.6): 10 records at 0.5, exactly 5 hits → observed 0.5.
    const records: SettledRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(
        rec({
          ourProb: 0.5,
          selection: "home",
          actualOutcome: i < 5 ? "home" : "away",
        }),
      );
    }
    const b = reliabilityBuckets(records, 10)[5]!; // [0.5, 0.6)
    expect(b.count).toBe(10);
    expect(b.predictedAvg).toBeCloseTo(0.5, 10);
    expect(b.observedFreq).toBeCloseTo(0.5, 10);
  });
});

// ── Validation-mode multiclass metrics over CalibrationPrediction[] ───────────

function ver(): PipelineVersion {
  return {
    pipelineVersion: "mvp-thin-chain-0.1.0",
    agentPromptVersions: {},
    modelAssignments: {},
    mathVersion: "poisson-1x2-0.1.0",
    dataProvider: "api-football-v3",
    deVigMethod: "proportional",
    valueThreshold: 0.05,
    createdAt: "2024-01-01T00:00:00Z",
    dataTimestamps: {},
  };
}

function cp(args: {
  probs?: OutcomeProbs;
  actualOutcome?: Outcome | null;
  market?: CalibrationPrediction["market"];
}): CalibrationPrediction {
  return {
    matchId: 1,
    league: "L",
    kickoff: "2024-01-01T00:00:00Z",
    probs: args.probs ?? { home: 0.5, draw: 0.3, away: 0.2 },
    lambda: { home: 1.4, away: 1.1 },
    actualOutcome: args.actualOutcome ?? null,
    brier: null,
    market: args.market,
    mode: "validation",
    version: ver(),
    createdAt: "2024-01-01T00:00:00Z",
    settledAt: null,
  };
}

/** Minimal market block; valueBacktest only reads bestSelection + rawOdds[best]. */
function market(bestSelection: Outcome | null, odds: number): CalibrationPrediction["market"] {
  const rawOdds = { home: 2.0, draw: 3.0, away: 4.0 };
  if (bestSelection) rawOdds[bestSelection] = odds;
  return {
    rawOdds,
    impliedRaw: { home: 0.5, draw: 0.33, away: 0.25 },
    overround: 0.08,
    deVigMethod: "proportional",
    fairProbs: { home: 0.46, draw: 0.31, away: 0.23 },
    value: {
      home: { ourProb: 0.5, fairProb: 0.46, edge: 0.04, hasValue: false },
      draw: { ourProb: 0.3, fairProb: 0.31, edge: -0.01, hasValue: false },
      away: { ourProb: 0.2, fairProb: 0.23, edge: -0.03, hasValue: false },
    },
    bestSelection,
    valueThreshold: 0.05,
  };
}

describe("multiclassBrierOne", () => {
  test("perfect confident call → 0", () => {
    expect(multiclassBrierOne({ home: 1, draw: 0, away: 0 }, "home")).toBeCloseTo(0, 10);
  });
  test("maximally wrong confident call → 2", () => {
    expect(multiclassBrierOne({ home: 0, draw: 0, away: 1 }, "home")).toBeCloseTo(2, 10);
  });
  test("uniform 1/3 each, actual home → 2/3", () => {
    expect(
      multiclassBrierOne({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, "home"),
    ).toBeCloseTo(2 / 3, 10);
  });
});

describe("multiclassBrier", () => {
  test("null when nothing is settled", () => {
    expect(multiclassBrier([cp({ actualOutcome: null })])).toBeNull();
  });
  test("a perfect confident call scores 0", () => {
    const p = cp({ probs: { home: 1, draw: 0, away: 0 }, actualOutcome: "home" });
    expect(multiclassBrier([p])).toBeCloseTo(0, 10);
  });
  test("a maximally wrong confident call scores 2", () => {
    const p = cp({ probs: { home: 0, draw: 0, away: 1 }, actualOutcome: "home" });
    expect(multiclassBrier([p])).toBeCloseTo(2, 10);
  });
  test("uniform 1/3 each, actual home → 2/3", () => {
    const p = cp({ probs: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, actualOutcome: "home" });
    expect(multiclassBrier([p])).toBeCloseTo(2 / 3, 10);
  });
  test("averages across settled predictions (unsettled ignored)", () => {
    const a = cp({ probs: { home: 1, draw: 0, away: 0 }, actualOutcome: "home" }); // 0
    const b = cp({ probs: { home: 0, draw: 0, away: 1 }, actualOutcome: "home" }); // 2
    const open = cp({ actualOutcome: null }); // ignored
    expect(multiclassBrier([a, b, open])).toBeCloseTo(1, 10);
  });
});

describe("accuracy (top-pick)", () => {
  test("null when nothing settled", () => {
    expect(accuracy([cp({ actualOutcome: null })])).toBeNull();
  });
  test("argmax matching the outcome counts as correct", () => {
    const a = cp({ probs: { home: 0.5, draw: 0.3, away: 0.2 }, actualOutcome: "home" }); // correct
    const b = cp({ probs: { home: 0.5, draw: 0.3, away: 0.2 }, actualOutcome: "away" }); // wrong
    expect(accuracy([a, b])).toBeCloseTo(0.5, 10);
  });
});

describe("baseRateBrier", () => {
  test("null when nothing settled", () => {
    expect(baseRateBrier([])).toBeNull();
  });
  test("hand-checkable: one home + one away → constant {0.5,0,0.5} scores 0.5", () => {
    // Probs are irrelevant to the base-rate model; only the outcomes matter.
    const a = cp({ actualOutcome: "home" });
    const b = cp({ actualOutcome: "away" });
    expect(baseRateBrier([a, b])).toBeCloseTo(0.5, 10);
  });
});

describe("reliabilityMulticlass", () => {
  test("pools the three outcome points per prediction into the right buckets", () => {
    // One settled pred: {0.75 home (hit), 0.15 draw (miss), 0.10 away (miss)}.
    const p = cp({ probs: { home: 0.75, draw: 0.15, away: 0.1 }, actualOutcome: "home" });
    const buckets = reliabilityMulticlass([p], 10);
    expect(buckets[7]!.count).toBe(1); // [0.7,0.8): the home point
    expect(buckets[7]!.observedFreq).toBeCloseTo(1, 10);
    expect(buckets[1]!.count).toBe(2); // [0.1,0.2): the draw + away points
    expect(buckets[1]!.observedFreq).toBeCloseTo(0, 10);
    expect(buckets[1]!.predictedAvg).toBeCloseTo((0.15 + 0.1) / 2, 10);
  });
});

describe("valueBacktest", () => {
  test("one win at 2.0 and one loss at 2.0 net 0, hit rate 0.5", () => {
    const preds = [
      cp({ actualOutcome: "home", market: market("home", 2.0) }), // win +1
      cp({ actualOutcome: "home", market: market("away", 2.0) }), // loss −1
    ];
    const r = valueBacktest(preds, 1);
    expect(r.bets).toBe(2);
    expect(r.staked).toBe(2);
    expect(r.profit).toBeCloseTo(0, 10);
    expect(r.roi).toBeCloseTo(0, 10);
    expect(r.hitRate).toBeCloseTo(0.5, 10);
  });

  test("hand-checkable: win at 3.0 and loss at 2.0 → +1, roi 0.5", () => {
    const preds = [
      cp({ actualOutcome: "home", market: market("home", 3.0) }), // +2
      cp({ actualOutcome: "home", market: market("away", 2.0) }), // −1
    ];
    const r = valueBacktest(preds, 1);
    expect(r.profit).toBeCloseTo(1, 10);
    expect(r.roi).toBeCloseTo(0.5, 10);
  });

  test("skips rows with no selection, no market, or still unsettled", () => {
    const preds = [
      cp({ actualOutcome: "home", market: market(null, 0) }), // no value selection
      cp({ actualOutcome: "home" }), // no market block at all
      cp({ actualOutcome: null, market: market("home", 2.0) }), // unsettled
    ];
    const r = valueBacktest(preds, 1);
    expect(r.bets).toBe(0);
    expect(r.staked).toBe(0);
    expect(r.profit).toBe(0);
    expect(r.roi).toBe(0);
    expect(r.hitRate).toBeNull();
  });

  test("respects stakeUnit scaling", () => {
    const preds = [cp({ actualOutcome: "home", market: market("home", 2.5) })]; // (2.5−1)*10
    const r = valueBacktest(preds, 10);
    expect(r.profit).toBeCloseTo(15, 10);
    expect(r.roi).toBeCloseTo(1.5, 10);
  });
});
