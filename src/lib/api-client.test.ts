import { expect, test } from "bun:test";

import { createApiClient } from "./api-client.ts";
import { Cache } from "./cache.ts";

/**
 * A stub fetchFn that returns canned, minimally-shaped API-Football payloads.
 * Each call records its URL so tests can assert which endpoint was hit.
 * The handler is keyed by a substring of the request path.
 */
function stubFetch(handler: (url: string) => unknown) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const payload = handler(url);
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function memCache(): Cache {
  return new Cache(":memory:");
}

// ─────────────────────────────────────────────────────────────────────────────
// getFixture
// ─────────────────────────────────────────────────────────────────────────────

test("getFixture normalizes a fixture row into FixtureRef", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        fixture: {
          id: 12345,
          date: "2026-06-20T18:00:00+00:00",
          venue: { name: "Old Trafford" },
          status: { short: "NS" },
        },
        league: { id: 39, name: "Premier League", season: 2025 },
        teams: {
          home: { id: 33, name: "Manchester United" },
          away: { id: 40, name: "Liverpool" },
        },
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const fixture = await client.getFixture(12345);

  expect(fixture).toEqual({
    id: 12345,
    league: { id: 39, name: "Premier League", season: 2025 },
    date: "2026-06-20T18:00:00+00:00",
    venue: "Old Trafford",
    status: "NS",
    home: { id: 33, name: "Manchester United" },
    away: { id: 40, name: "Liverpool" },
  });
});

test("getFixture returns null when the response is empty", async () => {
  const { fn } = stubFetch(() => ({ response: [] }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getFixture(999)).toBeNull();
});

test("getFixture maps a null venue to null", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        fixture: { id: 1, date: "2026-01-01T00:00:00+00:00", venue: { name: null }, status: { short: "NS" } },
        league: { id: 39, name: "PL", season: 2025 },
        teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } },
      },
    ],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const fixture = await client.getFixture(1);
  expect(fixture?.venue).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// getRecentForm
// ─────────────────────────────────────────────────────────────────────────────

test("getRecentForm maps home flag, goalsFor/Against and W/D/L from the subject perspective", async () => {
  const SUBJECT = 33;
  const { fn } = stubFetch(() => ({
    response: [
      // Subject at HOME, wins 3-1
      {
        fixture: { id: 100, date: "2026-06-01T00:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 33, name: "Subject" }, away: { id: 50, name: "Foe A" } },
        goals: { home: 3, away: 1 },
      },
      // Subject AWAY, loses 0-2 (i.e. home scored 2)
      {
        fixture: { id: 101, date: "2026-05-25T00:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 60, name: "Foe B" }, away: { id: 33, name: "Subject" } },
        goals: { home: 2, away: 0 },
      },
      // Subject AWAY, draws 1-1
      {
        fixture: { id: 102, date: "2026-05-18T00:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 70, name: "Foe C" }, away: { id: 33, name: "Subject" } },
        goals: { home: 1, away: 1 },
      },
      // Not finished — must be excluded from the window
      {
        fixture: { id: 103, date: "2026-06-10T00:00:00+00:00", status: { short: "NS" } },
        teams: { home: { id: 33, name: "Subject" }, away: { id: 80, name: "Foe D" } },
        goals: { home: null, away: null },
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const form = await client.getRecentForm(SUBJECT, 5);

  expect(form.windowSize).toBe(3); // the NS fixture is dropped
  expect(form.matches).toHaveLength(3);

  const [m0, m1, m2] = form.matches;

  // Match 0: home win 3-1
  expect(m0).toEqual({
    fixtureId: 100,
    date: "2026-06-01T00:00:00+00:00",
    opponent: { id: 50, name: "Foe A" },
    home: true,
    goalsFor: 3,
    goalsAgainst: 1,
    result: "W",
  });

  // Match 1: away loss — subject scored 0, conceded 2
  expect(m1?.home).toBe(false);
  expect(m1?.goalsFor).toBe(0);
  expect(m1?.goalsAgainst).toBe(2);
  expect(m1?.result).toBe("L");
  expect(m1?.opponent).toEqual({ id: 60, name: "Foe B" });

  // Match 2: away draw 1-1
  expect(m2?.home).toBe(false);
  expect(m2?.goalsFor).toBe(1);
  expect(m2?.goalsAgainst).toBe(1);
  expect(m2?.result).toBe("D");
});

test("getRecentForm returns an empty window when no fixtures are finished", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        fixture: { id: 1, date: "2026-06-10T00:00:00+00:00", status: { short: "NS" } },
        teams: { home: { id: 33, name: "S" }, away: { id: 80, name: "F" } },
        goals: { home: null, away: null },
      },
    ],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const form = await client.getRecentForm(33, 5);
  expect(form).toEqual({ windowSize: 0, matches: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRecentFormBySeason — historical/validation form (filter, sort DESC, take n)
// ─────────────────────────────────────────────────────────────────────────────

test("getRecentFormBySeason filters by beforeDate, sorts DESC, takes n, maps subject perspective", async () => {
  const SUBJECT = 33;
  const { fn, calls } = stubFetch(() => ({
    response: [
      // out of order on purpose; subject AWAY win 2-0 — newest BEFORE the cut
      {
        fixture: { id: 201, date: "2024-03-10T15:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 60, name: "Foe B" }, away: { id: 33, name: "Subject" } },
        goals: { home: 0, away: 2 },
      },
      // subject HOME win 3-1 — oldest of the three pre-cut games
      {
        fixture: { id: 200, date: "2024-02-01T15:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 33, name: "Subject" }, away: { id: 50, name: "Foe A" } },
        goals: { home: 3, away: 1 },
      },
      // subject HOME draw 1-1 — middle of the three pre-cut games
      {
        fixture: { id: 202, date: "2024-02-20T15:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 33, name: "Subject" }, away: { id: 70, name: "Foe C" } },
        goals: { home: 1, away: 1 },
      },
      // ON/AFTER the cut date → excluded (no lookahead)
      {
        fixture: { id: 203, date: "2024-04-01T15:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 33, name: "Subject" }, away: { id: 80, name: "Foe D" } },
        goals: { home: 5, away: 0 },
      },
      // not finished → excluded
      {
        fixture: { id: 204, date: "2024-03-01T15:00:00+00:00", status: { short: "NS" } },
        teams: { home: { id: 33, name: "Subject" }, away: { id: 90, name: "Foe E" } },
        goals: { home: null, away: null },
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  // Window of 2 from matches strictly before 2024-04-01.
  const form = await client.getRecentFormBySeason(SUBJECT, 39, 2023, 2, "2024-04-01T00:00:00+00:00");

  // Endpoint is /fixtures keyed by team+league+season (NOT last=N).
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/fixtures");
  expect(calls[0]).toContain("team=33");
  expect(calls[0]).toContain("league=39");
  expect(calls[0]).toContain("season=2023");
  expect(calls[0]).not.toContain("last=");

  // The future fixture (203) and the NS fixture (204) are excluded; n=2 takes the
  // two most-recent of the three remaining, newest first.
  expect(form.windowSize).toBe(2);
  expect(form.matches.map((m) => m.fixtureId)).toEqual([201, 202]);

  const [m0, m1] = form.matches;

  // Newest pre-cut: subject AWAY, won 2-0.
  expect(m0).toEqual({
    fixtureId: 201,
    date: "2024-03-10T15:00:00+00:00",
    opponent: { id: 60, name: "Foe B" },
    home: false,
    goalsFor: 2,
    goalsAgainst: 0,
    result: "W",
  });

  // Next: subject HOME, drew 1-1.
  expect(m1).toEqual({
    fixtureId: 202,
    date: "2024-02-20T15:00:00+00:00",
    opponent: { id: 70, name: "Foe C" },
    home: true,
    goalsFor: 1,
    goalsAgainst: 1,
    result: "D",
  });
});

test("getRecentFormBySeason without beforeDate keeps every finished game, sorted DESC", async () => {
  const SUBJECT = 33;
  const { fn } = stubFetch(() => ({
    response: [
      {
        fixture: { id: 300, date: "2024-01-01T00:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 33, name: "S" }, away: { id: 50, name: "A" } },
        goals: { home: 1, away: 0 },
      },
      {
        fixture: { id: 301, date: "2024-05-01T00:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 60, name: "B" }, away: { id: 33, name: "S" } },
        goals: { home: 2, away: 2 },
      },
    ],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const form = await client.getRecentFormBySeason(SUBJECT, 39, 2023, 10);
  expect(form.windowSize).toBe(2);
  // Most-recent first regardless of source order.
  expect(form.matches.map((m) => m.fixtureId)).toEqual([301, 300]);
});

test("getRecentFormBySeason returns an empty window when the response is empty", async () => {
  const { fn } = stubFetch(() => ({ response: [] }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const form = await client.getRecentFormBySeason(33, 39, 2023, 10);
  expect(form).toEqual({ windowSize: 0, matches: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLeagueSeasonResults — neutral finished-match results, outcome derivation
// ─────────────────────────────────────────────────────────────────────────────

test("getLeagueSeasonResults derives home/draw/away outcomes and skips an unfinished fixture", async () => {
  const { fn, calls } = stubFetch(() => ({
    response: [
      // home win
      {
        fixture: { id: 400, date: "2024-01-01T00:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 1, name: "Home A" }, away: { id: 2, name: "Away A" } },
        goals: { home: 2, away: 0 },
      },
      // draw (AET still counts as finished)
      {
        fixture: { id: 401, date: "2024-01-02T00:00:00+00:00", status: { short: "AET" } },
        teams: { home: { id: 3, name: "Home B" }, away: { id: 4, name: "Away B" } },
        goals: { home: 1, away: 1 },
      },
      // away win
      {
        fixture: { id: 402, date: "2024-01-03T00:00:00+00:00", status: { short: "FT" } },
        teams: { home: { id: 5, name: "Home C" }, away: { id: 6, name: "Away C" } },
        goals: { home: 0, away: 3 },
      },
      // unfinished → skipped
      {
        fixture: { id: 403, date: "2024-01-04T00:00:00+00:00", status: { short: "NS" } },
        teams: { home: { id: 7, name: "Home D" }, away: { id: 8, name: "Away D" } },
        goals: { home: null, away: null },
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const results = await client.getLeagueSeasonResults(39, 2023);

  // Endpoint keyed by league+season.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/fixtures");
  expect(calls[0]).toContain("league=39");
  expect(calls[0]).toContain("season=2023");

  // The NS fixture is dropped.
  expect(results).toHaveLength(3);

  expect(results[0]).toEqual({
    fixtureId: 400,
    date: "2024-01-01T00:00:00+00:00",
    home: { id: 1, name: "Home A" },
    away: { id: 2, name: "Away A" },
    goalsHome: 2,
    goalsAway: 0,
    outcome: "home",
    status: "FT",
  });
  expect(results[1]?.outcome).toBe("draw");
  expect(results[1]?.status).toBe("AET");
  expect(results[2]?.outcome).toBe("away");
  expect(results[2]?.goalsAway).toBe(3);
});

test("getLeagueSeasonResults returns [] when the response is empty", async () => {
  const { fn } = stubFetch(() => ({ response: [] }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getLeagueSeasonResults(39, 2023)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// getOdds — Match Winner extraction + median consensus
// ─────────────────────────────────────────────────────────────────────────────

test("getOdds extracts Match Winner and computes the median consensus across two bookmakers", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        bookmakers: [
          {
            id: 1,
            name: "Bookie One",
            bets: [
              {
                id: 1,
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "2.00" },
                  { value: "Draw", odd: "3.00" },
                  { value: "Away", odd: "4.00" },
                ],
              },
              // a non-1X2 bet that MUST be ignored
              { id: 5, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "1.90" }] },
            ],
          },
          {
            id: 2,
            name: "Bookie Two",
            bets: [
              {
                id: 1,
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "2.50" },
                  { value: "Draw", odd: "3.40" },
                  { value: "Away", odd: "3.20" },
                ],
              },
            ],
          },
        ],
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const odds = await client.getOdds(7777);

  expect(odds).not.toBeNull();
  expect(odds?.bookmakers).toHaveLength(2);
  expect(odds?.bookmakers[0]).toEqual({
    bookmaker: "Bookie One",
    odds: { home: 2.0, draw: 3.0, away: 4.0 },
  });

  // Two-bookmaker median = mean of the two values per outcome.
  expect(odds?.consensus.home).toBeCloseTo((2.0 + 2.5) / 2, 10);
  expect(odds?.consensus.draw).toBeCloseTo((3.0 + 3.4) / 2, 10);
  expect(odds?.consensus.away).toBeCloseTo((4.0 + 3.2) / 2, 10);
});

test("getOdds computes a true median (middle value) across three bookmakers", async () => {
  const mkBook = (name: string, h: string, d: string, a: string) => ({
    name,
    bets: [
      {
        id: 1,
        name: "Match Winner",
        values: [
          { value: "Home", odd: h },
          { value: "Draw", odd: d },
          { value: "Away", odd: a },
        ],
      },
    ],
  });
  const { fn } = stubFetch(() => ({
    response: [
      {
        bookmakers: [
          mkBook("A", "2.00", "3.00", "4.00"),
          mkBook("B", "2.20", "3.10", "3.80"),
          mkBook("C", "2.50", "3.50", "3.50"),
        ],
      },
    ],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const odds = await client.getOdds(1);
  // Odd count → the middle value after sorting.
  expect(odds?.consensus.home).toBeCloseTo(2.2, 10);
  expect(odds?.consensus.draw).toBeCloseTo(3.1, 10);
  expect(odds?.consensus.away).toBeCloseTo(3.8, 10);
});

test("getOdds returns null when no bookmaker has Match Winner", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        bookmakers: [
          {
            name: "Only Totals",
            bets: [{ id: 5, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "1.90" }] }],
          },
        ],
      },
    ],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getOdds(1)).toBeNull();
});

test("getOdds is fetched FRESH (bypasses the cache on repeated calls)", async () => {
  let toggle = 0;
  const fn = (async () => {
    toggle += 1;
    const home = toggle === 1 ? "2.00" : "9.99";
    const payload = {
      response: [
        {
          bookmakers: [
            {
              name: "B",
              bets: [
                {
                  id: 1,
                  name: "Match Winner",
                  values: [
                    { value: "Home", odd: home },
                    { value: "Draw", odd: "3.00" },
                    { value: "Away", odd: "4.00" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const first = await client.getOdds(1);
  const second = await client.getOdds(1);

  // No cache hit: the second call sees the new value, and the fetcher ran twice.
  expect(first?.consensus.home).toBeCloseTo(2.0, 10);
  expect(second?.consensus.home).toBeCloseTo(9.99, 10);
  expect(toggle).toBe(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// getCoverage
// ─────────────────────────────────────────────────────────────────────────────

test("getCoverage maps the coverage flags for the matching season, coercing nested shapes", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        league: { id: 39, name: "PL" },
        seasons: [
          { year: 2024, coverage: { fixtures: { events: true }, odds: false } },
          {
            year: 2025,
            coverage: {
              fixtures: { events: true, statistics_fixtures: true },
              standings: true,
              odds: true,
              predictions: true,
              injuries: false,
              // statistics may be exposed as nested flags
              statistics_fixtures: true,
              lineups: true,
            },
          },
        ],
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const cov = await client.getCoverage(39, 2025);

  expect(cov).toEqual({
    fixtures: true,
    statistics: true,
    standings: true,
    odds: true,
    predictions: true,
    lineups: true,
    injuries: false,
  });
});

test("getCoverage returns null when the season year is not present", async () => {
  const { fn } = stubFetch(() => ({
    response: [{ league: { id: 39 }, seasons: [{ year: 2024, coverage: {} }] }],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getCoverage(39, 2025)).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// getApiPredictions
// ─────────────────────────────────────────────────────────────────────────────

test("getApiPredictions converts percentage strings to fractions", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        predictions: {
          percent: { home: "45%", draw: "30%", away: "25%" },
        },
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const probs = await client.getApiPredictions(1);

  expect(probs?.home).toBeCloseTo(0.45, 10);
  expect(probs?.draw).toBeCloseTo(0.3, 10);
  expect(probs?.away).toBeCloseTo(0.25, 10);
});

test("getApiPredictions returns null when predictions are absent", async () => {
  const { fn } = stubFetch(() => ({ response: [{ predictions: {} }] }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getApiPredictions(1)).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// getBaseline
// ─────────────────────────────────────────────────────────────────────────────

test("getBaseline computes per-home and per-away rates, guarding divide-by-zero", async () => {
  const { fn } = stubFetch(() => ({
    response: {
      goals: {
        for: { total: { home: 20, away: 10 } },
        against: { total: { home: 8, away: 14 } },
      },
      fixtures: { played: { home: 10, away: 0 } },
    },
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const baseline = await client.getBaseline(33, 39, 2025);

  expect(baseline?.home).toEqual({
    matchesPlayed: 10,
    goalsForPerHome: 2.0, // 20 / 10
    goalsAgainstPerHome: 0.8, // 8 / 10
  });
  // played.away is 0 → guarded to 0 rather than NaN/Infinity.
  expect(baseline?.away).toEqual({
    matchesPlayed: 0,
    goalsForPerAway: 0,
    goalsAgainstPerAway: 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLeagueAverages
// ─────────────────────────────────────────────────────────────────────────────

test("getLeagueAverages sums the standings table and divides by total played", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        league: {
          standings: [
            [
              {
                home: { goals: { for: 20 }, played: 10 },
                away: { goals: { for: 12 }, played: 10 },
              },
              {
                home: { goals: { for: 10 }, played: 10 },
                away: { goals: { for: 8 }, played: 10 },
              },
            ],
          ],
        },
      },
    ],
  }));

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const avgs = await client.getLeagueAverages(39, 2025);

  // home: (20+10) / (10+10) = 1.5 ; away: (12+8) / (10+10) = 1.0
  expect(avgs?.avgHomeGoals).toBeCloseTo(1.5, 10);
  expect(avgs?.avgAwayGoals).toBeCloseTo(1.0, 10);
});

test("getLeagueAverages returns null when standings are missing", async () => {
  const { fn } = stubFetch(() => ({ response: [{ league: {} }] }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getLeagueAverages(39, 2025)).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// getFixtureResult
// ─────────────────────────────────────────────────────────────────────────────

test("getFixtureResult returns the outcome for a finished match", async () => {
  const { fn } = stubFetch(() => ({
    response: [
      {
        fixture: { id: 1, status: { short: "FT" } },
        goals: { home: 2, away: 1 },
      },
    ],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getFixtureResult(1)).toBe("home");
});

test("getFixtureResult returns draw and away correctly", async () => {
  const drawFetch = stubFetch(() => ({
    response: [{ fixture: { status: { short: "AET" } }, goals: { home: 1, away: 1 } }],
  }));
  const awayFetch = stubFetch(() => ({
    response: [{ fixture: { status: { short: "FT" } }, goals: { home: 0, away: 2 } }],
  }));
  const drawClient = createApiClient({ fetchFn: drawFetch.fn, cache: memCache() });
  const awayClient = createApiClient({ fetchFn: awayFetch.fn, cache: memCache() });
  expect(await drawClient.getFixtureResult(1)).toBe("draw");
  expect(await awayClient.getFixtureResult(1)).toBe("away");
});

test("getFixtureResult returns null when the match has not finished", async () => {
  const { fn } = stubFetch(() => ({
    response: [{ fixture: { status: { short: "NS" } }, goals: { home: null, away: null } }],
  }));
  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  expect(await client.getFixtureResult(1)).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// request helper: auth header, caching of stable GETs, retry on 5xx
// ─────────────────────────────────────────────────────────────────────────────

test("request sets the x-apisports-key auth header", async () => {
  let seenKey: string | null = null;
  const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenKey = headers.get("x-apisports-key");
    return new Response(JSON.stringify({ response: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  await client.getFixture(1);
  // API_KEY defaults to "" in test env, but the header must still be present.
  expect(seenKey).not.toBeNull();
});

test("stable GETs are cached: a second identical call does not re-fetch", async () => {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    const payload = {
      response: [
        {
          fixture: { id: 1, date: "d", venue: { name: "V" }, status: { short: "NS" } },
          league: { id: 39, name: "PL", season: 2025 },
          teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } },
        },
      ],
    };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const a = await client.getFixture(1);
  const b = await client.getFixture(1);
  expect(a).toEqual(b);
  expect(calls).toBe(1); // second call served from cache
});

test("request retries on a 5xx and succeeds on a later attempt", async () => {
  let attempts = 0;
  const fn = (async () => {
    attempts += 1;
    if (attempts < 3) return new Response("err", { status: 503 });
    return new Response(JSON.stringify({ response: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  const result = await client.getFixture(1);
  expect(result).toBeNull(); // empty response → null
  expect(attempts).toBe(3); // two 503s, then a 200
});

test("request retries on a thrown error then throws after exhausting retries", async () => {
  let attempts = 0;
  const fn = (async () => {
    attempts += 1;
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const client = createApiClient({ fetchFn: fn, cache: memCache() });
  await expect(client.getFixture(1)).rejects.toThrow("network down");
  expect(attempts).toBe(3); // initial + 2 retries
});
