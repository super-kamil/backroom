import { expect, test } from "bun:test";

import type { FixtureRef } from "./contracts.ts";
import {
  matchFixtures,
  nameMatches,
  normalizeName,
  parseTeams,
} from "./fixture-match.ts";

/** Build a minimal FixtureRef with the only fields matching cares about. */
function fx(
  id: number,
  home: string,
  away: string,
  league = "Friendlies",
): FixtureRef {
  return {
    id,
    league: { id: 1, name: league, season: 2026 },
    date: "2026-06-21T18:00:00+00:00",
    venue: null,
    status: "NS",
    home: { id: id * 10, name: home },
    away: { id: id * 10 + 1, name: away },
  };
}

// ── normalizeName ─────────────────────────────────────────────────────────────

test("normalizeName strips combining diacritics, punctuation, and case", () => {
  expect(normalizeName("Atlético Madrid")).toBe("atletico madrid");
  expect(normalizeName("São Paulo")).toBe("sao paulo");
  expect(normalizeName("  Iran!  ")).toBe("iran");
});

// ── parseTeams ────────────────────────────────────────────────────────────────

test("parseTeams splits on the common separators", () => {
  expect(parseTeams("belgium vs iran")).toEqual({ a: "belgium", b: "iran" });
  expect(parseTeams("belgium vs. iran")).toEqual({ a: "belgium", b: "iran" });
  expect(parseTeams("belgium v iran")).toEqual({ a: "belgium", b: "iran" });
  expect(parseTeams("belgium versus iran")).toEqual({
    a: "belgium",
    b: "iran",
  });
  expect(parseTeams("belgium - iran")).toEqual({ a: "belgium", b: "iran" });
  expect(parseTeams("belgium x iran")).toEqual({ a: "belgium", b: "iran" });
});

test("parseTeams drops time words and keeps multi-word team names", () => {
  expect(parseTeams("todays belgium vs iran")).toEqual({
    a: "belgium",
    b: "iran",
  });
  expect(parseTeams("manchester united vs real madrid")).toEqual({
    a: "manchester united",
    b: "real madrid",
  });
});

test("parseTeams leaves a hyphenated single name intact (no false split)", () => {
  // No surrounding spaces around the dash → not a separator.
  expect(parseTeams("saint-etienne")).toBeNull();
});

test("parseTeams returns null for a single-sided query", () => {
  expect(parseTeams("belgium")).toBeNull();
  expect(parseTeams("")).toBeNull();
  expect(parseTeams("today")).toBeNull();
});

// ── nameMatches ───────────────────────────────────────────────────────────────

test("nameMatches is tolerant to case and substrings, both directions", () => {
  expect(nameMatches("Iran", "iran")).toBe(true);
  expect(nameMatches("Manchester United", "united")).toBe(true);
  expect(nameMatches("Iran", "IR Iran")).toBe(true); // term contains the name
  expect(nameMatches("Belgium", "iran")).toBe(false);
  expect(nameMatches("Belgium", "")).toBe(false);
});

// ── matchFixtures ─────────────────────────────────────────────────────────────

const DAY = [
  fx(101, "Belgium", "Iran", "World Cup"),
  fx(102, "Brazil", "Serbia", "World Cup"),
  fx(103, "Iran", "USA", "World Cup"),
];

test("matchFixtures resolves a two-sided query regardless of home/away order", () => {
  const a = matchFixtures(DAY, "belgium vs iran");
  expect(a.status).toBe("ok");
  expect(a.resolved?.id).toBe(101);

  // Reversed order still resolves the same fixture.
  const b = matchFixtures(DAY, "iran vs belgium");
  expect(b.status).toBe("ok");
  expect(b.resolved?.id).toBe(101);
});

test("matchFixtures returns none when no fixture matches both teams", () => {
  const r = matchFixtures(DAY, "belgium vs brazil");
  expect(r.status).toBe("none");
  expect(r.resolved).toBeNull();
  expect(r.candidates).toEqual([]);
});

test("matchFixtures flags an ambiguous single-team query with all candidates", () => {
  const r = matchFixtures(DAY, "iran");
  expect(r.status).toBe("ambiguous");
  expect(r.resolved).toBeNull();
  expect(r.candidates.map((f) => f.id).sort()).toEqual([101, 103]);
});

test("matchFixtures de-duplicates the same fixture appearing twice", () => {
  const withDup = [...DAY, fx(101, "Belgium", "Iran", "World Cup")];
  const r = matchFixtures(withDup, "belgium vs iran");
  expect(r.status).toBe("ok");
  expect(r.candidates).toHaveLength(1);
  expect(r.resolved?.id).toBe(101);
});
