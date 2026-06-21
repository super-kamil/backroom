/**
 * historical-baseline.ts — PURE, no-I/O derivation of AS-OF-DATE Poisson
 * baselines from a list of finished MatchResult records (see contracts.ts).
 *
 * This is the validation-mode (calibration-only) counterpart to the LIVE
 * api-client.ts getBaseline/getLeagueAverages calls. Where the live path reads
 * a provider's season-to-date /teams/statistics aggregate, the backtest must
 * reconstruct the SAME PrefetchBundle["baseline"] shape from raw match results,
 * counting ONLY matches that kicked off BEFORE the fixture being predicted.
 *
 * NO LOOKAHEAD: every helper here filters on `date < beforeDateISO`, so a match
 * can never inform a prediction about itself or any later match. ISO 8601 dates
 * compare correctly as strings, so we compare them lexicographically (no Date
 * parsing, no timezone surprises) — consistent with the rest of the codebase.
 *
 * Mirrors the live mapper's conventions: per-match rates use the same safe
 * divide-by-zero guard (return 0 when there are no qualifying matches), and the
 * return shape is exactly PrefetchBundle["baseline"] so the Quant math is fed an
 * identical structure in both modes.
 */

import type {
  BaselineRates,
  FormWindow,
  MatchResult,
  MatchSummary,
  PrefetchBundle,
} from "./contracts.ts";

/**
 * A fixture is only predicted once a team has enough PRIOR matches (on the
 * relevant home/away side) to estimate its rates. Below this, the caller treats
 * the fixture as warmup and skips it rather than emitting a low-confidence call.
 */
export const MIN_PRIOR_MATCHES = 3;

/** Safe per-match rate: numerator / denominator, returning 0 when denom ≤ 0. */
function perMatch(numerator: number, denominator: number): number {
  if (!(denominator > 0)) return 0;
  return numerator / denominator;
}

/** True iff this result kicked off strictly before the cutoff (no lookahead). */
function isBefore(result: MatchResult, beforeDateISO: string): boolean {
  return result.date < beforeDateISO;
}

/**
 * League-wide average goals scored by home / away sides, over EVERY match that
 * kicked off before the cutoff. These normalize team rates into attack/defense
 * strengths downstream, exactly as the live league averages do.
 *
 * avgHomeGoals = Σ goalsHome / count, avgAwayGoals = Σ goalsAway / count, over
 * matches with date < beforeDateISO. With no prior matches, returns 0/0 so the
 * caller (computeBaselineFromFixtures) can detect insufficient warmup.
 */
export function computeLeagueAveragesAsOf(
  results: MatchResult[],
  beforeDateISO: string,
): BaselineRates["league"] {
  let sumHome = 0;
  let sumAway = 0;
  let count = 0;
  for (const r of results) {
    if (!isBefore(r, beforeDateISO)) continue;
    sumHome += r.goalsHome;
    sumAway += r.goalsAway;
    count += 1;
  }
  if (count === 0) return { avgHomeGoals: 0, avgAwayGoals: 0 };
  return {
    avgHomeGoals: sumHome / count,
    avgAwayGoals: sumAway / count,
  };
}

/**
 * One team's home and away scoring/conceding rates, derived from ONLY its
 * matches before the cutoff. A match where the team was the home side fills the
 * `home` sub-object; a match where it was the away side fills the `away`
 * sub-object — a match never contributes to both. Rates are guarded against
 * divide-by-zero (0 when that side has no qualifying matches).
 */
export function computeTeamRatesAsOf(
  results: MatchResult[],
  teamId: number,
  beforeDateISO: string,
): { home: BaselineRates["home"]; away: BaselineRates["away"] } {
  let playedHome = 0;
  let forHome = 0;
  let againstHome = 0;
  let playedAway = 0;
  let forAway = 0;
  let againstAway = 0;

  for (const r of results) {
    if (!isBefore(r, beforeDateISO)) continue;
    if (r.home.id === teamId) {
      playedHome += 1;
      forHome += r.goalsHome;
      againstHome += r.goalsAway;
    } else if (r.away.id === teamId) {
      playedAway += 1;
      forAway += r.goalsAway;
      againstAway += r.goalsHome;
    }
    // A match not involving this team contributes to neither side.
  }

  return {
    home: {
      matchesPlayed: playedHome,
      goalsForPerHome: perMatch(forHome, playedHome),
      goalsAgainstPerHome: perMatch(againstHome, playedHome),
    },
    away: {
      matchesPlayed: playedAway,
      goalsForPerAway: perMatch(forAway, playedAway),
      goalsAgainstPerAway: perMatch(againstAway, playedAway),
    },
  };
}

/**
 * Assemble the PrefetchBundle["baseline"] for a single fixture as-of its
 * kickoff: the home team's HOME rates, the away team's AWAY rates, and the
 * league averages — all computed from matches strictly before `beforeDateISO`.
 *
 * Returns null (the caller skips the fixture as insufficient warmup) when:
 *   - the home team has fewer than MIN_PRIOR_MATCHES prior HOME matches, or
 *   - the away team has fewer than MIN_PRIOR_MATCHES prior AWAY matches, or
 *   - either league average is 0 (i.e. no prior league matches to normalize on).
 */
export function computeBaselineFromFixtures(
  results: MatchResult[],
  homeId: number,
  awayId: number,
  beforeDateISO: string,
): PrefetchBundle["baseline"] | null {
  const homeRates = computeTeamRatesAsOf(results, homeId, beforeDateISO);
  const awayRates = computeTeamRatesAsOf(results, awayId, beforeDateISO);
  const league = computeLeagueAveragesAsOf(results, beforeDateISO);

  if (homeRates.home.matchesPlayed < MIN_PRIOR_MATCHES) return null;
  if (awayRates.away.matchesPlayed < MIN_PRIOR_MATCHES) return null;
  if (league.avgHomeGoals === 0 || league.avgAwayGoals === 0) return null;

  return {
    home: homeRates.home,
    away: awayRates.away,
    league,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE fallback: recent-form baseline for neutral-venue / data-thin competitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum games on one venue side (home or away) before the form proxy trusts
 * that split. Below this — common for international teams, who play few competitive
 * away legs — the slot falls back to the team's NEUTRAL all-games rate so the
 * estimate still runs rather than collapsing to a NO-BET on missing split data.
 */
export const MIN_FORM_SPLIT = 3;

/** Mean of a numeric selector over a list; 0 when empty (divide-by-zero guard). */
function meanBy(
  items: MatchSummary[],
  pick: (m: MatchSummary) => number,
): number {
  if (items.length === 0) return 0;
  let sum = 0;
  for (const m of items) sum += pick(m);
  return sum / items.length;
}

/**
 * LIVE fallback baseline for competitions with no usable within-competition
 * season aggregate (e.g. a neutral-venue World Cup, early in the tournament):
 * derive the Poisson rates from each team's recent-form window ACROSS ALL
 * competitions instead. The home team's HOME-side recent games fill its home
 * rates and the away team's AWAY-side recent games fill its away rates; when a
 * side has fewer than MIN_FORM_SPLIT games, that slot falls back to the team's
 * NEUTRAL (all-games) rate. League averages come from the pooled recent matches
 * of BOTH teams, split by venue, with a neutral fallback.
 *
 * Returns null only when neither team has any recent matches, or the pooled
 * matches yield a zero league average (nothing to normalize on).
 *
 * CALIBRATION CAVEAT: recent-form goals are NOT opposition-strength-adjusted
 * (friendlies vs weak sides inflate them), so this proxy is materially less
 * calibrated than a league season aggregate. It is a deliberate, documented
 * relaxation for tournament play — downstream confidence should reflect it, and
 * the Sharp critic is expected to flag soft opposition.
 */
export function computeBaselineFromForm(
  homeForm: FormWindow,
  awayForm: FormWindow,
): PrefetchBundle["baseline"] | null {
  const homeMatches = homeForm.matches;
  const awayMatches = awayForm.matches;
  if (homeMatches.length === 0 || awayMatches.length === 0) return null;

  // Home team's home rates: its HOME-side games if enough, else all (neutral).
  const homeHomeGames = homeMatches.filter((m) => m.home);
  const homeBasis =
    homeHomeGames.length >= MIN_FORM_SPLIT ? homeHomeGames : homeMatches;

  // Away team's away rates: its AWAY-side games if enough, else all (neutral).
  const awayAwayGames = awayMatches.filter((m) => !m.home);
  const awayBasis =
    awayAwayGames.length >= MIN_FORM_SPLIT ? awayAwayGames : awayMatches;

  // League averages from the pooled recent matches, split by venue, with a
  // neutral fallback when one venue side is unrepresented.
  const pooled = [...homeMatches, ...awayMatches];
  const homeSide = pooled.filter((m) => m.home);
  const awaySide = pooled.filter((m) => !m.home);
  const avgHomeGoals =
    homeSide.length > 0
      ? meanBy(homeSide, (m) => m.goalsFor)
      : meanBy(pooled, (m) => m.goalsFor);
  const avgAwayGoals =
    awaySide.length > 0
      ? meanBy(awaySide, (m) => m.goalsFor)
      : meanBy(pooled, (m) => m.goalsFor);
  if (avgHomeGoals === 0 || avgAwayGoals === 0) return null;

  return {
    home: {
      matchesPlayed: homeBasis.length,
      goalsForPerHome: meanBy(homeBasis, (m) => m.goalsFor),
      goalsAgainstPerHome: meanBy(homeBasis, (m) => m.goalsAgainst),
    },
    away: {
      matchesPlayed: awayBasis.length,
      goalsForPerAway: meanBy(awayBasis, (m) => m.goalsFor),
      goalsAgainstPerAway: meanBy(awayBasis, (m) => m.goalsAgainst),
    },
    league: { avgHomeGoals, avgAwayGoals },
  };
}
