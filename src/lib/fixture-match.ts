/**
 * fixture-match.ts — PURE, deterministic resolution of a human match description
 * into a concrete fixture. No network, no LLM: it takes a list of FixtureRefs
 * (fetched by api-client.ts) and a free-text query like "belgium vs iran", and
 * decides which fixture the user meant.
 *
 * This is the deterministic half of natural-language fixture resolution; the
 * networked half lives in api-client.ts (`searchFixturesByDate`) and the wiring
 * in src/scripts/resolve-fixture.ts. Keeping the matching pure makes it fully
 * unit-testable without touching the provider.
 *
 * Scope note: tuned for the common "<home> vs <away>" shape (national-team and
 * club fixtures). It is intentionally tolerant (case, diacritics, punctuation,
 * substrings) but not a fuzzy search engine — an ambiguous result is returned as
 * such so the caller can ask a human rather than guess.
 */

import type { FixtureRef } from "./contracts.ts";

export type MatchStatus = "ok" | "ambiguous" | "none";

export interface FixtureMatch {
  /** ok = exactly one fixture; ambiguous = several; none = zero. */
  status: MatchStatus;
  /** The single matched fixture when status === "ok", else null. */
  resolved: FixtureRef | null;
  /** All distinct fixtures that matched (length 1 when ok, ≥2 when ambiguous). */
  candidates: FixtureRef[];
}

/** Words that describe WHEN, not WHO — stripped before parsing team names. */
const TIME_WORDS = /\b(today|todays|tonight|tomorrow|match|game|fixture)\b/gi;

/**
 * Separators that split "<teamA> <sep> <teamB>". Word separators (vs / v / versus
 * / against / x) require surrounding whitespace; the dash form does too, so a
 * hyphenated club name (e.g. "Saint-Étienne") is left intact.
 */
const SEPARATOR = /\s+(?:vs?\.?|versus|against|x)\s+|\s+[-–—]\s+/i;

/**
 * Normalize a name/term for tolerant comparison: strip diacritics, lowercase, and
 * collapse any run of non-alphanumerics to a single space. "FC København" and
 * "fc kobenhavn" both fold to "fc kobenhavn".
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Split a free-text query into two team terms, or null if it is not a clear
 * two-sided description. Time words ("today", "tonight", …) are dropped first.
 */
export function parseTeams(query: string): { a: string; b: string } | null {
  const cleaned = query.replace(TIME_WORDS, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;

  const parts = cleaned
    .split(SEPARATOR)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 2) {
    const [a, b] = parts;
    if (a !== undefined && b !== undefined) return { a, b };
  }
  return null;
}

/**
 * Does a fixture's team name match a query term? True when either normalized
 * string contains the other (so "iran" matches "Iran", and "united" matches
 * "Manchester United"). Empty terms never match.
 */
export function nameMatches(teamName: string, term: string): boolean {
  const n = normalizeName(teamName);
  const t = normalizeName(term);
  if (n === "" || t === "") return false;
  return n === t || n.includes(t) || t.includes(n);
}

/** A fixture matches a {a,b} pair when the two terms cover its two sides, in either order. */
function pairMatches(f: FixtureRef, a: string, b: string): boolean {
  const aHome = nameMatches(f.home.name, a);
  const aAway = nameMatches(f.away.name, a);
  const bHome = nameMatches(f.home.name, b);
  const bAway = nameMatches(f.away.name, b);
  return (aHome && bAway) || (bHome && aAway);
}

/**
 * Resolve a free-text query against a day's fixtures.
 *
 * - A two-sided query ("belgium vs iran") matches fixtures where the two terms
 *   cover both sides, in either home/away order.
 * - A single-term query ("belgium") matches any fixture that team appears in —
 *   typically ambiguous, surfaced for the caller to disambiguate.
 *
 * Results are de-duplicated by fixture id. The status is ok / ambiguous / none by
 * the count of distinct matches.
 */
export function matchFixtures(
  fixtures: FixtureRef[],
  query: string,
): FixtureMatch {
  const teams = parseTeams(query);

  let matched: FixtureRef[];
  if (teams !== null) {
    matched = fixtures.filter((f) => pairMatches(f, teams.a, teams.b));
  } else {
    const term = query.replace(TIME_WORDS, " ").trim();
    matched =
      normalizeName(term) === ""
        ? []
        : fixtures.filter(
            (f) =>
              nameMatches(f.home.name, term) || nameMatches(f.away.name, term),
          );
  }

  // De-duplicate by fixture id (a date query can list the same fixture once, but
  // a widened multi-day window could surface duplicates).
  const seen = new Set<number>();
  const candidates = matched.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  if (candidates.length === 1) {
    return { status: "ok", resolved: candidates[0] ?? null, candidates };
  }
  if (candidates.length === 0) {
    return { status: "none", resolved: null, candidates: [] };
  }
  return { status: "ambiguous", resolved: null, candidates };
}
