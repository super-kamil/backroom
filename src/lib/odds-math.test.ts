/**
 * odds-math.test.ts — reference-value coverage for the deterministic core.
 * Run with `bun test`. Floats are compared with toBeCloseTo(_, 4).
 */

import { test, expect, describe } from "bun:test";
import type { OutcomeOdds } from "./contracts.ts";
import { MATH_VERSION } from "./config.ts";
import {
  impliedProbFromOdds,
  impliedProbs,
  overround,
  devigProportional,
  devig,
  computeValue,
  poissonPmf,
  scorelineMatrix,
  outcomeProbsFromMatrix,
  expectedGoals,
  computeOneXTwo,
  expectedValue,
  fixedPctStake,
  funPicks,
} from "./odds-math.ts";

// Symmetric baseline: both teams average exactly the league rate.
function symmetricBaseline(avgHome = 1.5, avgAway = 1.1) {
  return {
    home: {
      matchesPlayed: 19,
      goalsForPerHome: avgHome,
      goalsAgainstPerHome: avgAway,
    },
    away: {
      matchesPlayed: 19,
      goalsForPerAway: avgAway,
      goalsAgainstPerAway: avgHome,
    },
    league: { avgHomeGoals: avgHome, avgAwayGoals: avgAway },
  };
}

describe("impliedProbFromOdds", () => {
  test("2.0 → 0.5", () => {
    expect(impliedProbFromOdds(2.0)).toBeCloseTo(0.5, 4);
  });
  test("4.0 → 0.25", () => {
    expect(impliedProbFromOdds(4.0)).toBeCloseTo(0.25, 4);
  });
});

describe("impliedProbs / overround", () => {
  test("applies 1/odds per outcome", () => {
    const p = impliedProbs({ home: 2, draw: 4, away: 4 });
    expect(p.home).toBeCloseTo(0.5, 4);
    expect(p.draw).toBeCloseTo(0.25, 4);
    expect(p.away).toBeCloseTo(0.25, 4);
  });
  test("fair book has overround ≈ 0", () => {
    expect(overround(impliedProbs({ home: 2, draw: 4, away: 4 }))).toBeCloseTo(
      0,
      4,
    );
  });
});

describe("devigProportional", () => {
  test("fair book {2,4,4} → {0.5,0.25,0.25}", () => {
    const fair = devigProportional({ home: 2, draw: 4, away: 4 });
    expect(fair.home).toBeCloseTo(0.5, 4);
    expect(fair.draw).toBeCloseTo(0.25, 4);
    expect(fair.away).toBeCloseTo(0.25, 4);
    expect(fair.home + fair.draw + fair.away).toBeCloseTo(1, 4);
  });
  test("real book {1.5,4.0,7.0}: fair probs sum to 1, overround > 0", () => {
    const odds: OutcomeOdds = { home: 1.5, draw: 4.0, away: 7.0 };
    expect(overround(impliedProbs(odds))).toBeGreaterThan(0);
    const fair = devigProportional(odds);
    expect(fair.home + fair.draw + fair.away).toBeCloseTo(1, 4);
    // ordering preserved: heavy favorite still most likely.
    expect(fair.home).toBeGreaterThan(fair.draw);
    expect(fair.draw).toBeGreaterThan(fair.away);
  });
});

describe("devig dispatch + extension points", () => {
  test("proportional matches devigProportional", () => {
    const odds: OutcomeOdds = { home: 1.5, draw: 4.0, away: 7.0 };
    expect(devig(odds, "proportional")).toEqual(devigProportional(odds));
  });
  test("power throws (extension point)", () => {
    expect(() => devig({ home: 2, draw: 4, away: 4 }, "power")).toThrow(
      /not implemented/,
    );
  });
  test("shin throws (extension point)", () => {
    expect(() => devig({ home: 2, draw: 4, away: 4 }, "shin")).toThrow(
      /not implemented/,
    );
  });
});

describe("poissonPmf", () => {
  test("P(0; λ=1) ≈ 0.3679", () => {
    expect(poissonPmf(0, 1)).toBeCloseTo(0.3679, 4);
  });
  test("P(2; λ=2) ≈ 0.2707", () => {
    expect(poissonPmf(2, 2)).toBeCloseTo(0.2707, 4);
  });
  test("pmf over k=0..20 sums to ≈ 1", () => {
    let s = 0;
    for (let k = 0; k <= 20; k++) s += poissonPmf(k, 1.7);
    expect(s).toBeCloseTo(1, 4);
  });
  test("guards non-integer / negative k", () => {
    expect(poissonPmf(-1, 1)).toBe(0);
    expect(poissonPmf(1.5, 1)).toBe(0);
  });
});

describe("scorelineMatrix", () => {
  test("total mass ≈ 1 (maxGoals=10)", () => {
    const m = scorelineMatrix(1.6, 1.2);
    let total = 0;
    for (const row of m) for (const p of row) total += p;
    expect(total).toBeCloseTo(1, 4);
  });
  test("dimensions are (maxGoals+1) square", () => {
    const m = scorelineMatrix(1.5, 1.5, 5);
    expect(m.length).toBe(6);
    expect(m[0]?.length).toBe(6);
  });
});

describe("outcomeProbsFromMatrix", () => {
  test("sums to exactly 1", () => {
    const probs = outcomeProbsFromMatrix(scorelineMatrix(1.7, 1.3));
    expect(probs.home + probs.draw + probs.away).toBeCloseTo(1, 10);
  });
  test("symmetric λ → home ≈ away, draw > 0", () => {
    const probs = outcomeProbsFromMatrix(scorelineMatrix(1.4, 1.4));
    expect(probs.home).toBeCloseTo(probs.away, 4);
    expect(probs.draw).toBeGreaterThan(0);
  });
});

describe("expectedGoals", () => {
  test("symmetric league → λ near league averages", () => {
    const eg = expectedGoals(symmetricBaseline(1.5, 1.1));
    expect(eg.home).toBeCloseTo(1.5, 4);
    expect(eg.away).toBeCloseTo(1.1, 4);
  });
  test("league avg 0 → falls back to raw per-match rate", () => {
    const eg = expectedGoals({
      home: { matchesPlayed: 10, goalsForPerHome: 2, goalsAgainstPerHome: 1 },
      away: { matchesPlayed: 10, goalsForPerAway: 1, goalsAgainstPerAway: 2 },
      league: { avgHomeGoals: 0, avgAwayGoals: 0 },
    });
    expect(eg.home).toBeCloseTo(2, 4);
    expect(eg.away).toBeCloseTo(1, 4);
  });
  test("clamps λ to sane range", () => {
    const eg = expectedGoals({
      home: { matchesPlayed: 1, goalsForPerHome: 99, goalsAgainstPerHome: 99 },
      away: { matchesPlayed: 1, goalsForPerAway: 99, goalsAgainstPerAway: 99 },
      league: { avgHomeGoals: 1, avgAwayGoals: 1 },
    });
    expect(eg.home).toBeLessThanOrEqual(6);
    expect(eg.away).toBeLessThanOrEqual(6);
    expect(eg.home).toBeGreaterThanOrEqual(0.05);
  });
});

describe("computeOneXTwo", () => {
  test("three probs sum to 1", () => {
    const m = computeOneXTwo(symmetricBaseline());
    expect(m.probs.home + m.probs.draw + m.probs.away).toBeCloseTo(1, 10);
  });
  test("stamps MATH_VERSION and returns up to 7 scorelines", () => {
    const m = computeOneXTwo(symmetricBaseline());
    expect(m.mathVersion).toBe(MATH_VERSION);
    expect(m.scorelineTopN.length).toBe(7);
    // descending by probability
    for (let i = 1; i < m.scorelineTopN.length; i++) {
      const prev = m.scorelineTopN[i - 1];
      const cur = m.scorelineTopN[i];
      expect(prev!.prob).toBeGreaterThanOrEqual(cur!.prob);
    }
  });
  test("symmetric baseline → home ≈ away", () => {
    const m = computeOneXTwo(symmetricBaseline(1.3, 1.3));
    expect(m.probs.home).toBeCloseTo(m.probs.away, 4);
  });
});

describe("computeValue", () => {
  const odds: OutcomeOdds = { home: 1.5, draw: 4.0, away: 7.0 };

  test("carries the de-vig math and flags value only above the threshold", () => {
    const fair = devigProportional(odds);
    // Beat fair home by > 0.05; sit below fair on draw/away.
    const our = {
      home: fair.home + 0.08,
      draw: fair.draw - 0.04,
      away: fair.away - 0.04,
    };
    const v = computeValue(our, odds, "proportional", 0.05);
    expect(v.fairProbs).toEqual(fair);
    expect(v.overround).toBeCloseTo(overround(impliedProbs(odds)), 10);
    expect(v.value.home.edge).toBeCloseTo(0.08, 10);
    expect(v.value.home.hasValue).toBe(true);
    expect(v.value.draw.hasValue).toBe(false);
    expect(v.bestSelection).toBe("home");
    expect(v.deVigMethod).toBe("proportional");
  });

  test("no outcome clears the threshold → bestSelection null (NO-BET)", () => {
    const fair = devigProportional(odds);
    const our = {
      home: fair.home + 0.01,
      draw: fair.draw,
      away: fair.away - 0.01,
    };
    const v = computeValue(our, odds, "proportional", 0.05);
    expect(v.bestSelection).toBeNull();
    expect(Object.values(v.value).every((e) => e.hasValue === false)).toBe(
      true,
    );
  });

  test("edge identity holds for every outcome (edge === ourProb − fairProb)", () => {
    const our = { home: 0.5, draw: 0.3, away: 0.2 };
    const v = computeValue(our, odds, "proportional", 0.05);
    for (const o of ["home", "draw", "away"] as const) {
      expect(v.value[o].edge).toBeCloseTo(
        v.value[o].ourProb - v.value[o].fairProb,
        12,
      );
    }
  });

  test("picks the HIGHEST qualifying edge when several clear the bar", () => {
    // Symmetric fair book {0.5,0.25,0.25}; beat draw by more than home.
    const evenOdds: OutcomeOdds = { home: 2, draw: 4, away: 4 };
    const our = { home: 0.56, draw: 0.34, away: 0.1 }; // home edge .06, draw edge .09
    const v = computeValue(our, evenOdds, "proportional", 0.05);
    expect(v.value.home.hasValue).toBe(true);
    expect(v.value.draw.hasValue).toBe(true);
    expect(v.bestSelection).toBe("draw");
  });
});

describe("expectedValue", () => {
  test("(0.5, 2.0) → 0", () => {
    expect(expectedValue(0.5, 2.0)).toBeCloseTo(0, 4);
  });
  test("(0.6, 2.0) → 0.2", () => {
    expect(expectedValue(0.6, 2.0)).toBeCloseTo(0.2, 4);
  });
});

describe("fixedPctStake", () => {
  test("respects the cap", () => {
    expect(fixedPctStake(1000, 0.02, 50)).toBeCloseTo(20, 4);
    expect(fixedPctStake(10000, 0.02, 50)).toBeCloseTo(50, 4); // capped
  });
  test("never negative", () => {
    expect(fixedPctStake(-100, 0.02, 50)).toBe(0);
  });
});

describe("funPicks", () => {
  // Belgium vs Iran consensus: home 1.43 / draw 4.60 / away 7.50.
  const rawOdds: OutcomeOdds = { home: 1.43, draw: 4.6, away: 7.5 };
  const fairProbs = { home: 0.666, draw: 0.207, away: 0.127 };

  test("ranks favourite as safest, longest price as long-shot", () => {
    const picks = funPicks(rawOdds, fairProbs);
    expect(picks.safest.outcome).toBe("home");
    expect(picks.safest.odds).toBe(1.43);
    expect(picks.balanced.outcome).toBe("draw");
    expect(picks.longshot.outcome).toBe("away");
    expect(picks.longshot.odds).toBe(7.5);
  });

  test("carries the matching market fair prob through for each pick", () => {
    const picks = funPicks(rawOdds, fairProbs);
    expect(picks.safest.fairProb).toBeCloseTo(0.666, 4);
    expect(picks.longshot.fairProb).toBeCloseTo(0.127, 4);
  });

  test("does not depend on outcome order in the input", () => {
    // Away-favourite market: away has the lowest odds.
    const picks = funPicks(
      { home: 5.0, draw: 3.8, away: 1.6 },
      { home: 0.18, draw: 0.25, away: 0.57 },
    );
    expect(picks.safest.outcome).toBe("away");
    expect(picks.longshot.outcome).toBe("home");
  });
});
