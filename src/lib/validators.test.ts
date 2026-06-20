/**
 * validators.test.ts — coverage for the deterministic backpressure layer.
 * Run with `bun test`. Fixtures are built inline as valid baselines, then
 * mutated per-case so each failure isolates exactly one broken invariant.
 */

import { test, expect, describe } from "bun:test";
import { MATH_VERSION } from "./config.ts";
import {
  validateReport,
  crossCheckQuant,
  crossCheckTrader,
  crossCheckRisk,
  crossCheckHeadCoach,
  isProb,
  sumsToOne,
  approxEqual,
  type TraderMath,
} from "./validators.ts";

// ── Valid baseline fixtures (one per agent) ──────────────────────────────────

function validFormScout() {
  return {
    agent: "form-scout",
    home: {
      trend: "improving",
      formQuality: 0.7,
      qualityOfOpposition: "mid-table",
      notableSignals: ["clean sheets x3"],
      summary: "trending up",
    },
    away: {
      trend: "stable",
      formQuality: 0.4,
      qualityOfOpposition: "strong",
      notableSignals: [],
      summary: "steady",
    },
    confidence: 0.6,
    notes: "decent sample",
  };
}

function validQuant() {
  return {
    agent: "quant",
    math: {
      lambda: { home: 1.6, away: 1.1 },
      probs: { home: 0.48, draw: 0.27, away: 0.25 },
      scorelineTopN: [
        { home: 1, away: 1, prob: 0.12 },
        { home: 1, away: 0, prob: 0.11 },
        { home: 2, away: 1, prob: 0.09 },
      ],
      mathVersion: MATH_VERSION,
    },
    crossCheck: {
      source: "api-football-predictions",
      probs: { home: 0.45, draw: 0.28, away: 0.27 },
      agreement: "aligned",
    },
    sanityChecks: { sumsToOne: true, lambdaInRange: true, notes: "ok" },
    confidence: 0.55,
    notes: "independent estimate",
  };
}

function validTrader() {
  // fairProbs sum to 1; impliedRaw sums to 1 + overround; edges are exact.
  const impliedRaw = { home: 0.5, draw: 0.3, away: 0.28 }; // sum 1.08
  const overround = 0.08;
  const fairProbs = { home: 0.5, draw: 0.27, away: 0.23 };
  const ourProbs = { home: 0.58, draw: 0.24, away: 0.18 };
  const mk = (o: keyof typeof ourProbs) => {
    const ourProb = ourProbs[o];
    const fairProb = fairProbs[o];
    return { ourProb, fairProb, edge: ourProb - fairProb, hasValue: ourProb - fairProb >= 0.05 };
  };
  return {
    agent: "trader",
    rawOdds: { home: 2.0, draw: 3.33, away: 3.57 },
    impliedRaw,
    overround,
    deVigMethod: "proportional",
    fairProbs,
    value: { home: mk("home"), draw: mk("draw"), away: mk("away") },
    bestSelection: "home", // edge 0.08 >= 0.05, hasValue true
    valueThreshold: 0.05,
    notes: "home has value",
  };
}

function validRisk() {
  return {
    agent: "risk-manager",
    overround: 0.08,
    bankroll: 1000,
    stakePct: 0.02,
    rawStake: 20,
    recommendedStake: 20,
    stakeCapped: false,
    responsibleGambling: { pass: true, warnings: [] },
    approval: "approved",
    notes: "within limits",
  };
}

function validSharp() {
  return {
    agent: "sharp",
    verdict: "agree",
    challenges: [
      { type: "small-sample", severity: "low", argument: "only 5 matches" },
    ],
    recommendation: "proceed",
    notes: "no major objections",
  };
}

function fixtureRef() {
  return {
    id: 42,
    league: { id: 1, name: "Test League", season: 2026 },
    date: "2026-06-20T15:00:00Z",
    venue: "Stadium",
    status: "NS",
    home: { id: 10, name: "Home FC" },
    away: { id: 20, name: "Away FC" },
  };
}

function dataQuality() {
  return {
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
    reason: "all inputs present",
  };
}

function version() {
  return {
    pipelineVersion: "mvp-thin-chain-0.1.0",
    agentPromptVersions: {},
    modelAssignments: {},
    mathVersion: MATH_VERSION,
    dataProvider: "api-football-v3",
    deVigMethod: "proportional",
    valueThreshold: 0.05,
    createdAt: "2026-06-20T12:00:00Z",
    dataTimestamps: {},
  };
}

function validBetDecision() {
  const ourProb = 0.58;
  const fairProb = 0.5;
  return {
    matchId: 42,
    fixture: fixtureRef(),
    recommendation: "BET",
    selection: "home",
    ourProb,
    fairProb,
    edge: ourProb - fairProb,
    odds: 2.0,
    ev: 0.16,
    stake: 20,
    confidence: "medium",
    rationale: "edge clears threshold",
    dissent: { sharpVerdict: "agree", divergence: "none" },
    dataQuality: dataQuality(),
    version: version(),
  };
}

function validNoBetDecision() {
  return {
    matchId: 42,
    fixture: fixtureRef(),
    recommendation: "NO-BET",
    selection: null,
    ourProb: null,
    fairProb: null,
    edge: null,
    odds: null,
    ev: null,
    stake: null,
    confidence: "low",
    rationale: "no qualifying edge",
    dissent: { sharpVerdict: "uncertain", divergence: "minor" },
    dataQuality: dataQuality(),
    version: version(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

describe("isProb", () => {
  test("accepts [0,1], rejects out-of-range / non-finite", () => {
    expect(isProb(0)).toBe(true);
    expect(isProb(1)).toBe(true);
    expect(isProb(0.5)).toBe(true);
    expect(isProb(-0.01)).toBe(false);
    expect(isProb(1.01)).toBe(false);
    expect(isProb(NaN)).toBe(false);
    expect(isProb("0.5")).toBe(false);
  });
});

describe("sumsToOne", () => {
  test("tolerance is ±0.02 by default", () => {
    expect(sumsToOne({ home: 0.5, draw: 0.3, away: 0.2 })).toBe(true);
    expect(sumsToOne({ home: 0.5, draw: 0.3, away: 0.21 })).toBe(true); // 1.01
    expect(sumsToOne({ home: 0.5, draw: 0.3, away: 0.25 })).toBe(false); // 1.05
  });
});

describe("approxEqual", () => {
  test("within 1e-6", () => {
    expect(approxEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(approxEqual(0.5, 0.50001)).toBe(false);
  });
});

// ── Happy path: a minimal valid report of each type passes ──────────────────

describe("valid reports pass", () => {
  test("form-scout", () => {
    expect(validateReport("form-scout", validFormScout())).toEqual({
      ok: true,
      errors: [],
    });
  });
  test("quant", () => {
    expect(validateReport("quant", validQuant())).toEqual({ ok: true, errors: [] });
  });
  test("trader", () => {
    expect(validateReport("trader", validTrader())).toEqual({ ok: true, errors: [] });
  });
  test("risk-manager", () => {
    expect(validateReport("risk-manager", validRisk())).toEqual({
      ok: true,
      errors: [],
    });
  });
  test("sharp", () => {
    expect(validateReport("sharp", validSharp())).toEqual({ ok: true, errors: [] });
  });
  test("head-coach BET", () => {
    expect(validateReport("head-coach", validBetDecision())).toEqual({
      ok: true,
      errors: [],
    });
  });
  test("head-coach NO-BET", () => {
    expect(validateReport("head-coach", validNoBetDecision())).toEqual({
      ok: true,
      errors: [],
    });
  });
});

// ── Dispatch + structural failures ──────────────────────────────────────────

describe("dispatch", () => {
  test("unknown agent fails", () => {
    const r = validateReport("data-scout", {});
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("unknown agent");
  });
  test("non-object data fails", () => {
    expect(validateReport("quant", null).ok).toBe(false);
    expect(validateReport("trader", 42).ok).toBe(false);
  });
});

// ── BOUNDS failures ──────────────────────────────────────────────────────────

describe("numeric bounds", () => {
  test("a probability > 1 fails", () => {
    const q = validQuant();
    q.math.probs = { home: 1.5, draw: 0.27, away: 0.25 } as any;
    const r = validateReport("quant", q);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("math.probs.home"))).toBe(true);
  });

  test("a probs triple that does not sum to 1 fails", () => {
    const q = validQuant();
    q.math.probs = { home: 0.2, draw: 0.2, away: 0.2 } as any; // sum 0.6
    const r = validateReport("quant", q);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("must sum to ~1"))).toBe(true);
  });

  test("quant lambda out of (0,8] fails", () => {
    const q = validQuant();
    q.math.lambda = { home: 0, away: 1.1 } as any;
    const r = validateReport("quant", q);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("math.lambda.home"))).toBe(true);
  });

  test("quant scorelineTopN not sorted descending fails", () => {
    const q = validQuant();
    q.math.scorelineTopN = [
      { home: 1, away: 1, prob: 0.1 },
      { home: 0, away: 0, prob: 0.2 }, // ascending → invalid
    ];
    const r = validateReport("quant", q);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("sorted descending"))).toBe(true);
  });

  test("negative overround fails (trader)", () => {
    const t = validTrader();
    t.overround = -0.01 as any;
    const r = validateReport("trader", t);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("overround"))).toBe(true);
  });

  test("recommendedStake above MAX_STAKE fails", () => {
    const rk = validRisk();
    rk.recommendedStake = 10_000;
    const r = validateReport("risk-manager", rk);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("recommendedStake"))).toBe(true);
  });

  test("recommendedStake above bankroll fails", () => {
    const rk = validRisk();
    rk.bankroll = 30; // below the 50 cap and below the stake
    rk.recommendedStake = 40;
    const r = validateReport("risk-manager", rk);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("bankroll"))).toBe(true);
  });
});

// ── CONSISTENCY failures ─────────────────────────────────────────────────────

describe("trader consistency", () => {
  test("edge !== ourProb − fairProb fails", () => {
    const t = validTrader();
    t.value.home.edge = 0.99; // break the identity
    const r = validateReport("trader", t);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("value.home.edge"))).toBe(true);
  });

  test("overround !== sum(impliedRaw) − 1 fails", () => {
    const t = validTrader();
    t.overround = 0.2; // impliedRaw still sums to 1.08
    const r = validateReport("trader", t);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("sum(impliedRaw)"))).toBe(true);
  });

  test("bestSelection pointing at a non-value outcome fails", () => {
    const t = validTrader();
    t.bestSelection = "away"; // away edge is below threshold / hasValue false
    const r = validateReport("trader", t);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("bestSelection"))).toBe(true);
  });

  test("fairProbs not summing to 1 fails", () => {
    const t = validTrader();
    t.fairProbs = { home: 0.2, draw: 0.2, away: 0.2 };
    // keep edges consistent with the new fairProbs to isolate the sum failure
    (["home", "draw", "away"] as const).forEach((o) => {
      t.value[o].fairProb = 0.2;
      t.value[o].edge = t.value[o].ourProb - 0.2;
      t.value[o].hasValue = t.value[o].edge >= 0.05;
    });
    (t as any).bestSelection = null;
    const r = validateReport("trader", t);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("fairProbs: must sum to ~1"))).toBe(true);
  });
});

describe("head-coach consistency", () => {
  test("a BET decision missing a stake fails", () => {
    const d = validBetDecision();
    (d as any).stake = null;
    const r = validateReport("head-coach", d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("stake"))).toBe(true);
  });

  test("a NO-BET decision with a non-null selection fails", () => {
    const d = validNoBetDecision();
    (d as any).selection = "home";
    const r = validateReport("head-coach", d);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.includes('selection: must be null')),
    ).toBe(true);
  });

  test("a BET decision with edge !== ourProb − fairProb fails", () => {
    const d = validBetDecision();
    d.edge = 0.99;
    const r = validateReport("head-coach", d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("edge"))).toBe(true);
  });
});

// ── Collect-all behaviour: multiple errors surface in one pass ───────────────

describe("collects all errors", () => {
  test("multiple broken fields report together", () => {
    const q = validQuant();
    q.math.probs = { home: 1.5, draw: 0.2, away: 0.2 } as any; // out-of-range + bad sum
    (q as any).confidence = 2; // out of [0,1]
    (q as any).notes = 123; // wrong type
    const r = validateReport("quant", q);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Cross-checks: agent copies must EQUAL the deterministic *-math.json source ─
// This is the mechanical determinism boundary. A within-bounds altered number
// passes validateReport but MUST fail the cross-check.

function quantMath() {
  return validQuant().math; // the QuantMath the agent is meant to embed verbatim
}

function traderMath(): TraderMath {
  const { agent, notes, ...math } = validTrader();
  return math as TraderMath; // TraderMath = TraderReport minus prose
}

function riskMath() {
  return {
    overround: 0.08,
    bankroll: 1000,
    stakePct: 0.02,
    rawStake: 20,
    recommendedStake: 20,
    stakeCapped: false,
  };
}

describe("crossCheckQuant", () => {
  test("faithful copy passes", () => {
    expect(crossCheckQuant(validQuant(), quantMath())).toEqual([]);
  });

  test("a shaved draw (still summing to ~1, still in-bounds) FAILS the cross-check", () => {
    const q = validQuant();
    // move 0.05 from draw to home: triple still sums to 1, both still in [0,1],
    // so validateReport passes — but it is NOT the deterministic output.
    q.math.probs = { home: 0.53, draw: 0.22, away: 0.25 };
    expect(validateReport("quant", q).ok).toBe(true); // passes schema/bounds…
    const errs = crossCheckQuant(q, quantMath()); // …but fails equality
    expect(errs.some((e) => e.includes("math.probs.home"))).toBe(true);
    expect(errs.some((e) => e.includes("math.probs.draw"))).toBe(true);
  });

  test("an altered lambda fails", () => {
    const q = validQuant();
    q.math.lambda = { home: 2.0, away: 1.1 };
    expect(crossCheckQuant(q, quantMath()).some((e) => e.includes("math.lambda.home"))).toBe(true);
  });

  test("a wrong math version fails", () => {
    const q = validQuant();
    q.math.mathVersion = "tampered-9.9.9";
    expect(crossCheckQuant(q, quantMath()).some((e) => e.includes("mathVersion"))).toBe(true);
  });

  test("an altered scoreline probability fails", () => {
    const q = validQuant();
    q.math.scorelineTopN[0]!.prob = 0.99;
    expect(
      crossCheckQuant(q, quantMath()).some((e) => e.includes("scorelineTopN[0].prob")),
    ).toBe(true);
  });
});

describe("crossCheckTrader", () => {
  test("faithful copy passes", () => {
    expect(crossCheckTrader(validTrader(), traderMath())).toEqual([]);
  });

  test("an altered fair probability fails", () => {
    const t = validTrader();
    t.fairProbs = { ...t.fairProbs, home: 0.6 };
    expect(crossCheckTrader(t, traderMath()).some((e) => e.includes("fairProbs.home"))).toBe(true);
  });

  test("an altered edge in the value map fails", () => {
    const t = validTrader();
    t.value.home.edge = 0.2;
    expect(
      crossCheckTrader(t, traderMath()).some((e) => e.includes("value.home.edge")),
    ).toBe(true);
  });

  test("a flipped bestSelection fails", () => {
    const t = validTrader();
    (t as any).bestSelection = "draw";
    expect(
      crossCheckTrader(t, traderMath()).some((e) => e.includes("bestSelection")),
    ).toBe(true);
  });
});

describe("crossCheckRisk", () => {
  test("faithful copy passes", () => {
    expect(crossCheckRisk(validRisk(), riskMath())).toEqual([]);
  });

  test("an inflated recommendedStake fails", () => {
    const rk = validRisk();
    rk.recommendedStake = 35; // still within MAX_STAKE/bankroll, but not the computed value
    expect(
      crossCheckRisk(rk, riskMath()).some((e) => e.includes("recommendedStake")),
    ).toBe(true);
  });

  test("a flipped stakeCapped flag fails", () => {
    const rk = validRisk();
    rk.stakeCapped = true;
    expect(crossCheckRisk(rk, riskMath()).some((e) => e.includes("stakeCapped"))).toBe(true);
  });
});

describe("crossCheckHeadCoach", () => {
  function sources() {
    return {
      quantMath: {
        lambda: { home: 1.6, away: 1.1 },
        probs: { home: 0.58, draw: 0.24, away: 0.18 },
        scorelineTopN: [],
        mathVersion: MATH_VERSION,
      },
      traderMath: {
        rawOdds: { home: 2.0, draw: 3.33, away: 3.57 },
        impliedRaw: { home: 0.5, draw: 0.3, away: 0.28 },
        overround: 0.08,
        deVigMethod: "proportional" as const,
        fairProbs: { home: 0.5, draw: 0.27, away: 0.23 },
        value: {
          home: { ourProb: 0.58, fairProb: 0.5, edge: 0.08, hasValue: true },
          draw: { ourProb: 0.24, fairProb: 0.27, edge: -0.03, hasValue: false },
          away: { ourProb: 0.18, fairProb: 0.23, edge: -0.05, hasValue: false },
        },
        bestSelection: "home" as const,
        valueThreshold: 0.05,
      },
      riskMath: { recommendedStake: 20, ev: 0.16 },
      consensusOdds: { home: 2.0, draw: 3.33, away: 3.57 },
    };
  }

  test("a faithful BET decision passes", () => {
    expect(crossCheckHeadCoach(validBetDecision(), sources())).toEqual([]);
  });

  test("NO-BET carries no numbers → nothing to cross-check", () => {
    expect(crossCheckHeadCoach(validNoBetDecision(), sources())).toEqual([]);
  });

  test("an altered ourProb fails", () => {
    const d = validBetDecision();
    d.ourProb = 0.62; // not the quant-math source value 0.58
    expect(crossCheckHeadCoach(d, sources()).some((e) => e.includes("ourProb"))).toBe(true);
  });

  test("a stake that does not match risk-math fails", () => {
    const d = validBetDecision();
    d.stake = 25;
    expect(crossCheckHeadCoach(d, sources()).some((e) => e.includes("stake"))).toBe(true);
  });

  test("a selection other than the trader's bestSelection fails", () => {
    const d = validBetDecision();
    d.selection = "draw";
    // ourProb/fairProb/edge/odds for 'draw' won't match either, but the selection
    // mismatch is the headline error.
    expect(
      crossCheckHeadCoach(d, sources()).some((e) => e.includes("bestSelection")),
    ).toBe(true);
  });
});
