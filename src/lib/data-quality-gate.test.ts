/**
 * data-quality-gate.test.ts — reference coverage for the deterministic gate.
 *
 * The gate is the pipeline's cheap early stop: it must FAIL closed (NO-BET)
 * whenever odds, the season baseline, or either form window is insufficient, and
 * it must carry an honest inputConfidence on a pass. These tests pin the exact
 * pass/fail boundary and the high/medium/low confidence ladder so a future edit
 * can't silently loosen it. Run with `bun test`.
 */

import { test, expect, describe } from "bun:test";
import type { MatchSummary, PrefetchBundle } from "./contracts.ts";
import { evaluateGate, MIN_FIXTURES } from "./data-quality-gate.ts";

// ── Fixture builders ─────────────────────────────────────────────────────────

/** n placeholder finished matches (only the array LENGTH matters to the gate). */
function forms(n: number): MatchSummary[] {
  const out: MatchSummary[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      fixtureId: 1000 + i,
      date: `2024-01-${String(i + 1).padStart(2, "0")}T15:00:00+00:00`,
      opponent: { id: 90 + i, name: `Opp ${i}` },
      home: i % 2 === 0,
      goalsFor: 1,
      goalsAgainst: 1,
      result: "D",
    });
  }
  return out;
}

/** A fully-sufficient bundle; pass `overrides` to break exactly one input. */
function bundle(overrides: Partial<PrefetchBundle> = {}): PrefetchBundle {
  const base: PrefetchBundle = {
    fixture: {
      id: 42,
      league: { id: 39, name: "Premier League", season: 2024 },
      date: "2024-03-01T15:00:00+00:00",
      venue: "Stadium",
      status: "NS",
      home: { id: 10, name: "Home FC" },
      away: { id: 20, name: "Away FC" },
    },
    coverage: {
      fixtures: true,
      statistics: true,
      standings: true,
      odds: true,
      predictions: true,
      lineups: false,
      injuries: false,
    },
    form: {
      home: { windowSize: 8, matches: forms(8) },
      away: { windowSize: 8, matches: forms(8) },
    },
    baseline: {
      home: {
        matchesPlayed: 14,
        goalsForPerHome: 1.7,
        goalsAgainstPerHome: 1.0,
      },
      away: {
        matchesPlayed: 14,
        goalsForPerAway: 1.2,
        goalsAgainstPerAway: 1.3,
      },
      league: { avgHomeGoals: 1.5, avgAwayGoals: 1.1 },
    },
    odds: {
      bookmakers: [],
      consensus: { home: 2.1, draw: 3.4, away: 3.6 },
    },
    dataTimestamps: {},
    missing: [],
  };
  return { ...base, ...overrides };
}

// ── The pass boundary + confidence ladder ────────────────────────────────────

describe("evaluateGate — pass", () => {
  test("MIN_FIXTURES is 5", () => {
    expect(MIN_FIXTURES).toBe(5);
  });

  test("full inputs → pass, all checks true, confidence high, nothing missing", () => {
    const r = evaluateGate(bundle());
    expect(r.gate).toBe("pass");
    expect(r.checks).toEqual({
      oddsAvailable: true,
      sufficientHomeForm: true,
      sufficientAwayForm: true,
      baselineAvailable: true,
      coverageChecked: true,
    });
    expect(r.missing).toEqual([]);
    expect(r.inputConfidence).toBe("high");
  });

  test("forms at exactly MIN_FIXTURES (5) → pass but confidence only medium", () => {
    const r = evaluateGate(
      bundle({
        form: {
          home: { windowSize: 5, matches: forms(5) },
          away: { windowSize: 5, matches: forms(5) },
        },
      }),
    );
    expect(r.gate).toBe("pass");
    expect(r.inputConfidence).toBe("medium"); // < FULL_FORM_WINDOW (8)
  });

  test("a pass with a carried-over prefetch gap is medium, not high, and names the gap", () => {
    const r = evaluateGate(bundle({ missing: ["apiPredictions"] }));
    expect(r.gate).toBe("pass");
    expect(r.inputConfidence).toBe("medium");
    expect(r.missing).toContain("apiPredictions");
    expect(r.reason).toContain("apiPredictions");
  });
});

// ── The fail boundary — the gate must fail closed ────────────────────────────

describe("evaluateGate — fail closed", () => {
  test("missing odds (consensus not > 1) → fail, confidence low", () => {
    const r = evaluateGate(
      bundle({
        odds: { bookmakers: [], consensus: { home: 0, draw: 0, away: 0 } },
      }),
    );
    expect(r.gate).toBe("fail");
    expect(r.checks.oddsAvailable).toBe(false);
    expect(r.missing).toContain("odds:consensus");
    expect(r.inputConfidence).toBe("low");
  });

  test("a single odd at exactly 1.0 (no payout) is treated as unavailable", () => {
    const r = evaluateGate(
      bundle({
        odds: {
          bookmakers: [],
          consensus: { home: 1.0, draw: 3.4, away: 3.6 },
        },
      }),
    );
    expect(r.gate).toBe("fail");
    expect(r.checks.oddsAvailable).toBe(false);
  });

  test("home form one short of MIN_FIXTURES → fail", () => {
    const r = evaluateGate(
      bundle({
        form: {
          home: { windowSize: 4, matches: forms(4) },
          away: { windowSize: 8, matches: forms(8) },
        },
      }),
    );
    expect(r.gate).toBe("fail");
    expect(r.checks.sufficientHomeForm).toBe(false);
    expect(r.checks.sufficientAwayForm).toBe(true);
    expect(r.missing.some((m) => m.includes("form:home"))).toBe(true);
  });

  test("zero league average → baseline unavailable → fail", () => {
    const r = evaluateGate(
      bundle({
        baseline: {
          home: {
            matchesPlayed: 14,
            goalsForPerHome: 1.7,
            goalsAgainstPerHome: 1.0,
          },
          away: {
            matchesPlayed: 14,
            goalsForPerAway: 1.2,
            goalsAgainstPerAway: 1.3,
          },
          league: { avgHomeGoals: 0, avgAwayGoals: 1.1 },
        },
      }),
    );
    expect(r.gate).toBe("fail");
    expect(r.checks.baselineAvailable).toBe(false);
    expect(r.missing.some((m) => m.includes("baseline"))).toBe(true);
  });

  test("zero matchesPlayed → baseline unavailable → fail", () => {
    const r = evaluateGate(
      bundle({
        baseline: {
          home: {
            matchesPlayed: 0,
            goalsForPerHome: 0,
            goalsAgainstPerHome: 0,
          },
          away: {
            matchesPlayed: 14,
            goalsForPerAway: 1.2,
            goalsAgainstPerAway: 1.3,
          },
          league: { avgHomeGoals: 1.5, avgAwayGoals: 1.1 },
        },
      }),
    );
    expect(r.gate).toBe("fail");
    expect(r.checks.baselineAvailable).toBe(false);
  });

  test("multiple deficiencies all surface at once (no early bail)", () => {
    const r = evaluateGate(
      bundle({
        odds: { bookmakers: [], consensus: { home: 0, draw: 0, away: 0 } },
        form: {
          home: { windowSize: 1, matches: forms(1) },
          away: { windowSize: 1, matches: forms(1) },
        },
      }),
    );
    expect(r.gate).toBe("fail");
    expect(r.missing).toContain("odds:consensus");
    expect(r.missing.some((m) => m.includes("form:home"))).toBe(true);
    expect(r.missing.some((m) => m.includes("form:away"))).toBe(true);
  });
});
