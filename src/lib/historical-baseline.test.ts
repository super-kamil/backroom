/**
 * historical-baseline.test.ts — the no-lookahead guarantee, pinned.
 *
 * This is the #1 way a backtest lies: leaking a match's own result (or any later
 * match) into the strength estimate that "predicts" it. These tests assert the
 * as-of-date derivation counts ONLY matches strictly before the cutoff — a match
 * dated on or after `beforeDate` must change nothing — plus the exact rate math
 * and the MIN_PRIOR_MATCHES warmup guard. Run with `bun test`.
 */

import { test, expect, describe } from "bun:test";
import type { FormWindow, MatchResult, MatchSummary } from "./contracts.ts";
import {
  MIN_PRIOR_MATCHES,
  MIN_FORM_SPLIT,
  computeLeagueAveragesAsOf,
  computeTeamRatesAsOf,
  computeBaselineFromFixtures,
  computeBaselineFromForm,
} from "./historical-baseline.ts";

// ── Fixture builder ──────────────────────────────────────────────────────────

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

const CUTOFF = "2024-03-01T00:00:00+00:00";

// Six matches strictly BEFORE the cutoff. Subject home team = 1, away team = 2.
const PRIOR: MatchResult[] = [
  mr(1, "2024-01-01T15:00:00+00:00", 1, 3, 2, 0), // T1 home 2-0
  mr(2, "2024-01-08T15:00:00+00:00", 1, 4, 1, 1), // T1 home 1-1
  mr(3, "2024-02-01T15:00:00+00:00", 1, 5, 3, 1), // T1 home 3-1
  mr(4, "2024-01-05T15:00:00+00:00", 6, 2, 0, 1), // T2 away 0-1 (won)
  mr(5, "2024-01-12T15:00:00+00:00", 7, 2, 2, 2), // T2 away 2-2
  mr(6, "2024-02-05T15:00:00+00:00", 8, 2, 1, 0), // T2 away 1-0 (lost)
];

// A blowout exactly AT the cutoff and another AFTER it — both must be ignored.
const AT_CUTOFF = mr(7, CUTOFF, 1, 2, 9, 9);
const AFTER = mr(8, "2024-03-15T15:00:00+00:00", 1, 2, 9, 9);

// ── League averages ──────────────────────────────────────────────────────────

describe("computeLeagueAveragesAsOf", () => {
  test("averages goals over every prior match", () => {
    const avg = computeLeagueAveragesAsOf(PRIOR, CUTOFF);
    // Σ home goals = 2+1+3+0+2+1 = 9; Σ away = 0+1+1+1+2+0 = 5; n = 6.
    expect(avg.avgHomeGoals).toBeCloseTo(1.5, 10);
    expect(avg.avgAwayGoals).toBeCloseTo(5 / 6, 10);
  });

  test("no prior matches → 0/0 (lets the caller detect insufficient warmup)", () => {
    expect(computeLeagueAveragesAsOf([], CUTOFF)).toEqual({
      avgHomeGoals: 0,
      avgAwayGoals: 0,
    });
  });

  test("a match AT the cutoff is excluded (strict <)", () => {
    const avg = computeLeagueAveragesAsOf([...PRIOR, AT_CUTOFF], CUTOFF);
    expect(avg.avgHomeGoals).toBeCloseTo(1.5, 10); // unchanged by the 9-9 at-cutoff game
    expect(avg.avgAwayGoals).toBeCloseTo(5 / 6, 10);
  });
});

// ── Team rates ───────────────────────────────────────────────────────────────

describe("computeTeamRatesAsOf", () => {
  test("home team's HOME rates over prior home matches", () => {
    const t1 = computeTeamRatesAsOf(PRIOR, 1, CUTOFF);
    expect(t1.home.matchesPlayed).toBe(3);
    expect(t1.home.goalsForPerHome).toBeCloseTo(2, 10); // (2+1+3)/3
    expect(t1.home.goalsAgainstPerHome).toBeCloseTo(2 / 3, 10); // (0+1+1)/3
    expect(t1.away.matchesPlayed).toBe(0); // T1 was never the away side here
  });

  test("away team's AWAY rates over prior away matches (goals from its perspective)", () => {
    const t2 = computeTeamRatesAsOf(PRIOR, 2, CUTOFF);
    expect(t2.away.matchesPlayed).toBe(3);
    expect(t2.away.goalsForPerAway).toBeCloseTo(1, 10); // away goals (1+2+0)/3
    expect(t2.away.goalsAgainstPerAway).toBeCloseTo(1, 10); // home goals conceded (0+2+1)/3
    expect(t2.home.matchesPlayed).toBe(0);
  });

  test("a match the team did not play contributes to neither side", () => {
    const t99 = computeTeamRatesAsOf(PRIOR, 99, CUTOFF);
    expect(t99.home.matchesPlayed).toBe(0);
    expect(t99.away.matchesPlayed).toBe(0);
  });

  test("NO LOOKAHEAD: an at-cutoff and a future match change nothing", () => {
    const t1 = computeTeamRatesAsOf([...PRIOR, AT_CUTOFF, AFTER], 1, CUTOFF);
    expect(t1.home.matchesPlayed).toBe(3); // not 5
    expect(t1.home.goalsForPerHome).toBeCloseTo(2, 10); // not inflated by the 9-9 games
  });
});

// ── The assembled as-of baseline ─────────────────────────────────────────────

describe("computeBaselineFromFixtures", () => {
  test("MIN_PRIOR_MATCHES is 3", () => {
    expect(MIN_PRIOR_MATCHES).toBe(3);
  });

  test("assembles home/away/league from prior matches only", () => {
    const b = computeBaselineFromFixtures(PRIOR, 1, 2, CUTOFF);
    expect(b).not.toBeNull();
    expect(b!.home.goalsForPerHome).toBeCloseTo(2, 10);
    expect(b!.home.goalsAgainstPerHome).toBeCloseTo(2 / 3, 10);
    expect(b!.away.goalsForPerAway).toBeCloseTo(1, 10);
    expect(b!.away.goalsAgainstPerAway).toBeCloseTo(1, 10);
    expect(b!.league.avgHomeGoals).toBeCloseTo(1.5, 10);
    expect(b!.league.avgAwayGoals).toBeCloseTo(5 / 6, 10);
  });

  test("NO LOOKAHEAD: adding at-cutoff + future matches leaves the baseline identical", () => {
    const clean = computeBaselineFromFixtures(PRIOR, 1, 2, CUTOFF);
    const withFuture = computeBaselineFromFixtures(
      [...PRIOR, AT_CUTOFF, AFTER],
      1,
      2,
      CUTOFF,
    );
    expect(withFuture).toEqual(clean);
  });

  test("returns null when the home team has < MIN_PRIOR_MATCHES prior HOME games", () => {
    // Drop match 3 → T1 has only 2 prior home matches.
    const thin = PRIOR.filter((m) => m.fixtureId !== 3);
    expect(computeBaselineFromFixtures(thin, 1, 2, CUTOFF)).toBeNull();
  });

  test("returns null when the away team has < MIN_PRIOR_MATCHES prior AWAY games", () => {
    const thin = PRIOR.filter((m) => m.fixtureId !== 6);
    expect(computeBaselineFromFixtures(thin, 1, 2, CUTOFF)).toBeNull();
  });

  test("returns null when there are no prior matches to normalize on (league avg 0)", () => {
    // Everything is on/after the cutoff → zero warmup.
    const future = [AT_CUTOFF, AFTER];
    expect(computeBaselineFromFixtures(future, 1, 2, CUTOFF)).toBeNull();
  });
});

// ── LIVE recent-form fallback baseline ───────────────────────────────────────

/** Build a MatchSummary from the subject team's perspective. */
function ms(
  home: boolean,
  goalsFor: number,
  goalsAgainst: number,
  date = "2026-06-01T00:00:00+00:00",
): MatchSummary {
  return {
    fixtureId: 0,
    date,
    opponent: { id: 999, name: "Opp" },
    home,
    goalsFor,
    goalsAgainst,
    result: goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D",
  };
}

const fw = (matches: MatchSummary[]): FormWindow => ({
  windowSize: matches.length,
  matches,
});

describe("computeBaselineFromForm", () => {
  test("MIN_FORM_SPLIT is 3", () => {
    expect(MIN_FORM_SPLIT).toBe(3);
  });

  test("uses each team's venue split when both sides have >= MIN_FORM_SPLIT games", () => {
    // Home team: 3 home games scoring 2/2/2, conceding 0/0/0; plus an away game.
    const homeForm = fw([
      ms(true, 2, 0),
      ms(true, 2, 0),
      ms(true, 2, 0),
      ms(false, 1, 1),
    ]);
    // Away team: 3 away games scoring 1/1/1, conceding 2/2/2; plus a home game.
    const awayForm = fw([
      ms(false, 1, 2),
      ms(false, 1, 2),
      ms(false, 1, 2),
      ms(true, 3, 0),
    ]);

    const b = computeBaselineFromForm(homeForm, awayForm);
    expect(b).not.toBeNull();
    expect(b!.home.matchesPlayed).toBe(3); // only the home-side games
    expect(b!.home.goalsForPerHome).toBeCloseTo(2, 10);
    expect(b!.home.goalsAgainstPerHome).toBeCloseTo(0, 10);
    expect(b!.away.matchesPlayed).toBe(3); // only the away-side games
    expect(b!.away.goalsForPerAway).toBeCloseTo(1, 10);
    expect(b!.away.goalsAgainstPerAway).toBeCloseTo(2, 10);
  });

  test("falls back to the team's NEUTRAL all-games rate when a venue split is thin", () => {
    // Away team has only 2 away games (< MIN_FORM_SPLIT) → use all 4 of its games.
    const homeForm = fw([ms(true, 2, 0), ms(true, 2, 0), ms(true, 2, 0)]);
    const awayForm = fw([
      ms(false, 4, 0),
      ms(false, 4, 0),
      ms(true, 1, 0),
      ms(true, 1, 0),
    ]);

    const b = computeBaselineFromForm(homeForm, awayForm);
    expect(b).not.toBeNull();
    expect(b!.away.matchesPlayed).toBe(4); // neutral fallback: all games, not the 2 away
    expect(b!.away.goalsForPerAway).toBeCloseTo((4 + 4 + 1 + 1) / 4, 10); // 2.5
  });

  test("league averages are pooled across both windows, split by venue", () => {
    const homeForm = fw([ms(true, 3, 0), ms(true, 1, 0), ms(true, 2, 0)]); // 3 home-side, GF 3/1/2
    const awayForm = fw([ms(false, 2, 0), ms(false, 0, 0), ms(false, 1, 0)]); // 3 away-side, GF 2/0/1

    const b = computeBaselineFromForm(homeForm, awayForm);
    expect(b).not.toBeNull();
    expect(b!.league.avgHomeGoals).toBeCloseTo((3 + 1 + 2) / 3, 10); // pooled home side
    expect(b!.league.avgAwayGoals).toBeCloseTo((2 + 0 + 1) / 3, 10); // pooled away side
  });

  test("returns null when either form window is empty", () => {
    expect(computeBaselineFromForm(fw([]), fw([ms(false, 1, 1)]))).toBeNull();
    expect(computeBaselineFromForm(fw([ms(true, 1, 1)]), fw([]))).toBeNull();
  });
});
