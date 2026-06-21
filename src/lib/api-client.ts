/**
 * api-client.ts — the deterministic API-Football (api-sports.io v3) client.
 *
 * This is the ONLY lib that touches the network. It normalizes raw provider
 * responses into the contracts.ts shapes so agents and scripts never see raw
 * JSON. STABLE data (coverage, fixtures, season stats, standings, predictions)
 * is cached with STABLE_TTL_MS; live odds are fetched FRESH (cache bypassed),
 * per the data policy.
 *
 * Defensive throughout: every response is verified non-empty before indexing,
 * and missing/empty payloads return null/[] so the caller records the item as
 * missing rather than crashing.
 *
 * MVP MARKET: 1X2 (Match Winner / bet id 1) ONLY. Over/Under, BTTS, player
 * props and parlays are extension points and MUST NOT be read here.
 */

import type {
  BaselineRates,
  BookmakerOdds,
  Coverage,
  FixtureRef,
  FormWindow,
  MatchResult,
  MatchSummary,
  OddsData,
  Outcome,
  OutcomeOdds,
  OutcomeProbs,
  TeamRef,
} from "./contracts.ts";
import { API_BASE_URL, API_KEY } from "./config.ts";
import { Cache, STABLE_TTL_MS } from "./cache.ts";
import { CACHE_DB_PATH } from "./run-paths.ts";

// ── HTTP / retry tunables ─────────────────────────────────────────────────────
const MAX_RETRIES = 2; // up to 2 retries (3 total attempts)
const BACKOFF_BASE_MS = 250;

// ── Small numeric helpers (hand-written, no black boxes) ──────────────────────

/** Median of a numeric list. Empty → 0. Even length → mean of the two middles. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

/** Safe per-match rate: numerator / denominator, returning 0 when denom ≤ 0. */
function perMatch(numerator: number, denominator: number): number {
  if (!(denominator > 0)) return 0;
  return numerator / denominator;
}

/** Coerce any of API-Football's coverage flag shapes (bool, object, etc.) to boolean. */
function toBool(flag: unknown): boolean {
  if (typeof flag === "boolean") return flag;
  if (flag === null || flag === undefined) return false;
  // Coverage flags can be nested objects ({ ...: true }); treat any non-empty
  // object as "covered", and coerce primitives sensibly.
  if (typeof flag === "object") return Object.keys(flag).length > 0;
  if (typeof flag === "number") return flag !== 0;
  if (typeof flag === "string") return flag.length > 0 && flag !== "false";
  return Boolean(flag);
}

/** Number-or-null coercion: undefined/null/NaN → 0 for arithmetic safety. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Parse a percentage string like "45%" into a 0..1 fraction. */
function pctToFraction(s: unknown): number {
  if (typeof s === "number") return s > 1 ? s / 100 : s;
  if (typeof s !== "string") return 0;
  const n = Number(s.replace("%", "").trim());
  return Number.isFinite(n) ? n / 100 : 0;
}

// ── Public factory ────────────────────────────────────────────────────────────

export interface ApiClient {
  getCoverage(leagueId: number, season: number): Promise<Coverage | null>;
  getFixture(fixtureId: number): Promise<FixtureRef | null>;
  /**
   * Every fixture scheduled on a given calendar date (provider timezone, default
   * UTC), normalized to FixtureRef[]. Powers natural-language fixture resolution
   * ("belgium vs iran" → a fixture id) so the chain can be driven by team names
   * instead of a hand-found id. Live schedules can shift, so the default is a
   * FRESH (cache-bypassing) fetch; pass `{ fresh: false }` for an immutable past
   * date to spare the rate limit.
   */
  searchFixturesByDate(
    dateISO: string,
    opts?: { fresh?: boolean; timezone?: string },
  ): Promise<FixtureRef[]>;
  getRecentForm(teamId: number, last: number): Promise<FormWindow>;
  /**
   * Historical form window for VALIDATION mode. Pulls a whole (league, season) of
   * the team's fixtures (STABLE-cached), keeps only FINISHED games, optionally
   * those strictly before `beforeDateISO` (no lookahead), sorts DESC, takes `n`,
   * and maps each to a MatchSummary from the subject team's perspective. Replaces
   * the paid `last=N` path for completed seasons.
   */
  getRecentFormBySeason(
    teamId: number,
    leagueId: number,
    season: number,
    n: number,
    beforeDateISO?: string,
  ): Promise<FormWindow>;
  /**
   * Every FINISHED fixture in a (league, season), normalized to a neutral
   * MatchResult (home/away perspective). STABLE-cached. The backtest derives
   * as-of-date baselines from this list. Non-finished fixtures are skipped.
   */
  getLeagueSeasonResults(
    leagueId: number,
    season: number,
  ): Promise<MatchResult[]>;
  getBaseline(
    teamId: number,
    leagueId: number,
    season: number,
  ): Promise<{
    home: BaselineRates["home"];
    away: BaselineRates["away"];
  } | null>;
  getLeagueAverages(
    leagueId: number,
    season: number,
  ): Promise<BaselineRates["league"] | null>;
  /**
   * 1X2 consensus odds for a fixture. Live odds are volatile, so the default is a
   * FRESH (cache-bypassing) fetch. For a COMPLETED-season backtest the odds are
   * immutable, so callers may pass `{ fresh: false }` to serve them from the
   * STABLE cache and stay under the rate limit.
   */
  getOdds(
    fixtureId: number,
    opts?: { fresh?: boolean },
  ): Promise<OddsData | null>;
  getApiPredictions(fixtureId: number): Promise<OutcomeProbs | null>;
  getFixtureResult(fixtureId: number): Promise<Outcome | null>;
}

export interface CreateApiClientOpts {
  fetchFn?: typeof fetch;
  cache?: Cache;
}

export function createApiClient(opts: CreateApiClientOpts = {}): ApiClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const cache = opts.cache ?? new Cache(CACHE_DB_PATH);

  // ── private request helper ─────────────────────────────────────────────────
  // Builds the query string, sets the auth header, retries up to MAX_RETRIES on
  // a thrown error or a 5xx with await-based backoff, parses JSON, and (unless
  // fresh) caches stable GETs keyed by path+params.
  async function request(
    path: string,
    params: Record<string, string | number>,
    reqOpts: { fresh?: boolean } = {},
  ): Promise<unknown> {
    const query = new URLSearchParams();
    // Sort keys for a stable cache key regardless of insertion order.
    for (const key of Object.keys(params).sort()) {
      query.set(key, String(params[key]));
    }
    const qs = query.toString();
    const cacheKey = `${path}?${qs}`;
    const url = `${API_BASE_URL}${path}${qs ? `?${qs}` : ""}`;

    if (!reqOpts.fresh) {
      const cached = cache.get<unknown>(cacheKey);
      if (cached !== null) return cached;
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchFn(url, {
          method: "GET",
          headers: { "x-apisports-key": API_KEY },
        });
        // Retry on 5xx; other non-OK statuses are terminal (4xx won't recover).
        if (res.status >= 500) {
          lastErr = new Error(`api-football ${res.status} for ${path}`);
          if (attempt < MAX_RETRIES) {
            await backoff(attempt);
            continue;
          }
          throw lastErr;
        }
        const json = (await res.json()) as unknown;
        if (!reqOpts.fresh) cache.set(cacheKey, json, STABLE_TTL_MS);
        return json;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          await backoff(attempt);
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw lastErr ?? new Error(`api-football request failed for ${path}`);
  }

  function backoff(attempt: number): Promise<void> {
    const ms = BACKOFF_BASE_MS * (attempt + 1);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Extract the `response` array, or [] if absent/empty/malformed. */
  function responseArray(json: unknown): unknown[] {
    if (
      json &&
      typeof json === "object" &&
      Array.isArray((json as { response?: unknown }).response)
    ) {
      return (json as { response: unknown[] }).response;
    }
    return [];
  }

  // ── Methods ────────────────────────────────────────────────────────────────

  async function getCoverage(
    leagueId: number,
    season: number,
  ): Promise<Coverage | null> {
    const json = await request("/leagues", { id: leagueId, season });
    const arr = responseArray(json);
    const first = arr[0] as { seasons?: unknown[] } | undefined;
    if (!first || !Array.isArray(first.seasons)) return null;

    const entry = first.seasons.find(
      (s): s is { year: number; coverage?: Record<string, unknown> } =>
        !!s &&
        typeof s === "object" &&
        (s as { year?: unknown }).year === season,
    );
    if (!entry) return null;

    const cov = (entry.coverage ?? {}) as Record<string, unknown>;
    // API-Football nests the per-fixture statistics flags under `coverage.fixtures`
    // (coverage.fixtures.statistics_fixtures / .statistics_players). Read them there
    // first; fall back to any flattened/top-level shape for resilience.
    const fixturesCov =
      cov.fixtures && typeof cov.fixtures === "object"
        ? (cov.fixtures as Record<string, unknown>)
        : {};
    return {
      fixtures: toBool(cov.fixtures),
      statistics:
        toBool(fixturesCov.statistics_fixtures) ||
        toBool(fixturesCov.statistics_players) ||
        toBool(cov.statistics) ||
        toBool(cov.statistics_fixtures) ||
        toBool(cov.statistics_players),
      standings: toBool(cov.standings),
      odds: toBool(cov.odds),
      predictions: toBool(cov.predictions),
      lineups: toBool(fixturesCov.lineups) || toBool(cov.lineups),
      injuries: toBool(cov.injuries),
    };
  }

  async function getFixture(fixtureId: number): Promise<FixtureRef | null> {
    const json = await request("/fixtures", { id: fixtureId });
    const arr = responseArray(json);
    const row = arr[0];
    return row ? normalizeFixture(row) : null;
  }

  async function searchFixturesByDate(
    dateISO: string,
    opts: { fresh?: boolean; timezone?: string } = {},
  ): Promise<FixtureRef[]> {
    // Schedules for "today" can still change, so default to FRESH; a past date is
    // immutable and the caller may opt into the STABLE cache instead.
    const params: Record<string, string | number> = { date: dateISO };
    if (opts.timezone !== undefined && opts.timezone !== "") {
      params.timezone = opts.timezone;
    }
    const json = await request("/fixtures", params, {
      fresh: opts.fresh ?? true,
    });
    const arr = responseArray(json);

    const fixtures: FixtureRef[] = [];
    for (const row of arr) {
      const fx = normalizeFixture(row);
      // Defensive: skip rows that normalized without a usable id.
      if (fx.id > 0) fixtures.push(fx);
    }
    return fixtures;
  }

  async function getRecentForm(
    teamId: number,
    last: number,
  ): Promise<FormWindow> {
    const json = await request("/fixtures", { team: teamId, last });
    const arr = responseArray(json);

    const matches: MatchSummary[] = [];
    for (const row of arr) {
      const summary = toMatchSummary(row, teamId);
      if (summary) matches.push(summary);
    }
    return { windowSize: matches.length, matches };
  }

  async function getRecentFormBySeason(
    teamId: number,
    leagueId: number,
    season: number,
    n: number,
    beforeDateISO?: string,
  ): Promise<FormWindow> {
    // STABLE-cached: a completed season's fixtures never change.
    const json = await request("/fixtures", {
      team: teamId,
      league: leagueId,
      season,
    });
    const arr = responseArray(json);

    // toMatchSummary already drops non-finished fixtures and any game the subject
    // team isn't in. Map first, then apply the as-of-date cut and ordering.
    let matches: MatchSummary[] = [];
    for (const row of arr) {
      const summary = toMatchSummary(row, teamId);
      if (summary) matches.push(summary);
    }

    // No-lookahead cut: keep only matches strictly BEFORE the prediction kickoff.
    if (beforeDateISO !== undefined) {
      matches = matches.filter((m) => m.date < beforeDateISO);
    }

    // Most-recent first, then take the window of size n.
    matches.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (n >= 0) matches = matches.slice(0, n);

    return { windowSize: matches.length, matches };
  }

  async function getLeagueSeasonResults(
    leagueId: number,
    season: number,
  ): Promise<MatchResult[]> {
    // STABLE-cached: a completed season's results are immutable.
    const json = await request("/fixtures", { league: leagueId, season });
    const arr = responseArray(json);

    const results: MatchResult[] = [];
    for (const row of arr) {
      const result = toMatchResult(row);
      if (result) results.push(result);
    }
    return results;
  }

  async function getBaseline(
    teamId: number,
    leagueId: number,
    season: number,
  ): Promise<{
    home: BaselineRates["home"];
    away: BaselineRates["away"];
  } | null> {
    const json = await request("/teams/statistics", {
      team: teamId,
      league: leagueId,
      season,
    });
    // /teams/statistics returns a single object in `response` (not an array of rows).
    const resp = (json as { response?: unknown })?.response;
    if (!resp || typeof resp !== "object" || Array.isArray(resp)) return null;

    const stats = resp as {
      goals?: {
        for?: { total?: { home?: unknown; away?: unknown } };
        against?: { total?: { home?: unknown; away?: unknown } };
      };
      fixtures?: { played?: { home?: unknown; away?: unknown } };
    };

    const playedHome = num(stats.fixtures?.played?.home);
    const playedAway = num(stats.fixtures?.played?.away);
    const forHome = num(stats.goals?.for?.total?.home);
    const forAway = num(stats.goals?.for?.total?.away);
    const againstHome = num(stats.goals?.against?.total?.home);
    const againstAway = num(stats.goals?.against?.total?.away);

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

  async function getLeagueAverages(
    leagueId: number,
    season: number,
  ): Promise<BaselineRates["league"] | null> {
    const json = await request("/standings", { league: leagueId, season });
    const arr = responseArray(json);
    const first = arr[0] as { league?: { standings?: unknown } } | undefined;
    const standings = first?.league?.standings;
    if (!Array.isArray(standings)) return null;
    const table = standings[0];
    if (!Array.isArray(table) || table.length === 0) return null;

    let totalHomeGoalsFor = 0;
    let totalHomePlayed = 0;
    let totalAwayGoalsFor = 0;
    let totalAwayPlayed = 0;

    for (const r of table) {
      const row = r as {
        home?: { goals?: { for?: unknown }; played?: unknown };
        away?: { goals?: { for?: unknown }; played?: unknown };
      };
      totalHomeGoalsFor += num(row.home?.goals?.for);
      totalHomePlayed += num(row.home?.played);
      totalAwayGoalsFor += num(row.away?.goals?.for);
      totalAwayPlayed += num(row.away?.played);
    }

    return {
      avgHomeGoals: perMatch(totalHomeGoalsFor, totalHomePlayed),
      avgAwayGoals: perMatch(totalAwayGoalsFor, totalAwayPlayed),
    };
  }

  async function getOdds(
    fixtureId: number,
    opts: { fresh?: boolean } = {},
  ): Promise<OddsData | null> {
    // Live odds are volatile → FRESH by default. A completed-season backtest can
    // opt into the STABLE cache (odds are immutable once the match has played).
    const fresh = opts.fresh ?? true;
    const json = await request("/odds", { fixture: fixtureId }, { fresh });
    const arr = responseArray(json);

    const bookmakers: BookmakerOdds[] = [];
    for (const row of arr) {
      const entry = row as { bookmakers?: unknown[] };
      if (!Array.isArray(entry.bookmakers)) continue;
      for (const bm of entry.bookmakers) {
        const parsed = parseBookmaker(bm);
        if (parsed) bookmakers.push(parsed);
      }
    }

    if (bookmakers.length === 0) return null;

    const consensus: OutcomeOdds = {
      home: median(bookmakers.map((b) => b.odds.home)),
      draw: median(bookmakers.map((b) => b.odds.draw)),
      away: median(bookmakers.map((b) => b.odds.away)),
    };

    return { bookmakers, consensus };
  }

  async function getApiPredictions(
    fixtureId: number,
  ): Promise<OutcomeProbs | null> {
    const json = await request("/predictions", { fixture: fixtureId });
    const arr = responseArray(json);
    const first = arr[0] as
      | {
          predictions?: {
            percent?: { home?: unknown; draw?: unknown; away?: unknown };
          };
        }
      | undefined;
    const percent = first?.predictions?.percent;
    if (!percent) return null;
    return {
      home: pctToFraction(percent.home),
      draw: pctToFraction(percent.draw),
      away: pctToFraction(percent.away),
    };
  }

  async function getFixtureResult(fixtureId: number): Promise<Outcome | null> {
    const json = await request("/fixtures", { id: fixtureId }, { fresh: true });
    const arr = responseArray(json);
    const row = arr[0] as
      | {
          fixture?: { status?: { short?: unknown } };
          goals?: { home?: unknown; away?: unknown };
        }
      | undefined;
    if (!row) return null;

    const short = String(row.fixture?.status?.short ?? "");
    if (!FINISHED_STATUSES.has(short)) return null;

    const home = row.goals?.home;
    const away = row.goals?.away;
    if (typeof home !== "number" || typeof away !== "number") return null;

    if (home > away) return "home";
    if (home < away) return "away";
    return "draw";
  }

  return {
    getCoverage,
    getFixture,
    searchFixturesByDate,
    getRecentForm,
    getRecentFormBySeason,
    getLeagueSeasonResults,
    getBaseline,
    getLeagueAverages,
    getOdds,
    getApiPredictions,
    getFixtureResult,
  };
}

// ── Normalization helpers (pure; shared shapes) ───────────────────────────────

/** API-Football statuses that mean the match has fully resolved. */
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN"]);

function teamRef(t: unknown): TeamRef {
  const team = (t ?? {}) as { id?: unknown; name?: unknown };
  return { id: num(team.id), name: String(team.name ?? "") };
}

function normalizeFixture(row: unknown): FixtureRef {
  const r = row as {
    fixture?: {
      id?: unknown;
      date?: unknown;
      venue?: { name?: unknown } | null;
      status?: { short?: unknown };
    };
    league?: { id?: unknown; name?: unknown; season?: unknown };
    teams?: { home?: unknown; away?: unknown };
  };
  const venueName = r.fixture?.venue?.name;
  return {
    id: num(r.fixture?.id),
    league: {
      id: num(r.league?.id),
      name: String(r.league?.name ?? ""),
      season: num(r.league?.season),
    },
    date: String(r.fixture?.date ?? ""),
    venue:
      typeof venueName === "string" && venueName.length > 0 ? venueName : null,
    status: String(r.fixture?.status?.short ?? ""),
    home: teamRef(r.teams?.home),
    away: teamRef(r.teams?.away),
  };
}

/**
 * Map one /fixtures row into a MatchSummary FROM THE SUBJECT TEAM PERSPECTIVE.
 * Returns null for matches that are not finished (only resolved games count
 * toward a form window).
 */
function toMatchSummary(row: unknown, teamId: number): MatchSummary | null {
  const r = row as {
    fixture?: { id?: unknown; date?: unknown; status?: { short?: unknown } };
    teams?: { home?: unknown; away?: unknown };
    goals?: { home?: unknown; away?: unknown };
  };

  const short = String(r.fixture?.status?.short ?? "");
  if (!FINISHED_STATUSES.has(short)) return null;

  const homeTeam = teamRef(r.teams?.home);
  const awayTeam = teamRef(r.teams?.away);
  const isHome = homeTeam.id === teamId;
  // Defensive: if the subject team isn't in this fixture, skip it.
  if (!isHome && awayTeam.id !== teamId) return null;

  const goalsHome = num(r.goals?.home);
  const goalsAway = num(r.goals?.away);
  const goalsFor = isHome ? goalsHome : goalsAway;
  const goalsAgainst = isHome ? goalsAway : goalsHome;
  const opponent = isHome ? awayTeam : homeTeam;

  let result: MatchSummary["result"];
  if (goalsFor > goalsAgainst) result = "W";
  else if (goalsFor < goalsAgainst) result = "L";
  else result = "D";

  return {
    fixtureId: num(r.fixture?.id),
    date: String(r.fixture?.date ?? ""),
    opponent,
    home: isHome,
    goalsFor,
    goalsAgainst,
    result,
  };
}

/**
 * Map one /fixtures row into a neutral MatchResult (HOME/AWAY perspective, not
 * subject-team). Returns null for any fixture that has not fully resolved — the
 * backtest only derives strength from finished games.
 */
function toMatchResult(row: unknown): MatchResult | null {
  const r = row as {
    fixture?: { id?: unknown; date?: unknown; status?: { short?: unknown } };
    teams?: { home?: unknown; away?: unknown };
    goals?: { home?: unknown; away?: unknown };
  };

  const short = String(r.fixture?.status?.short ?? "");
  if (!FINISHED_STATUSES.has(short)) return null;

  const goalsHome = num(r.goals?.home);
  const goalsAway = num(r.goals?.away);

  let outcome: Outcome;
  if (goalsHome > goalsAway) outcome = "home";
  else if (goalsAway > goalsHome) outcome = "away";
  else outcome = "draw";

  return {
    fixtureId: num(r.fixture?.id),
    date: String(r.fixture?.date ?? ""),
    home: teamRef(r.teams?.home),
    away: teamRef(r.teams?.away),
    goalsHome,
    goalsAway,
    outcome,
    status: short,
  };
}

/**
 * Parse one bookmaker block, reading the "Match Winner" (bet id 1) values.
 * Returns null when the bookmaker has no Match Winner bet or it is malformed.
 */
function parseBookmaker(bm: unknown): BookmakerOdds | null {
  const b = bm as { name?: unknown; bets?: unknown[] };
  if (!Array.isArray(b.bets)) return null;

  const bet = b.bets.find((x) => {
    const bx = x as { id?: unknown; name?: unknown };
    return num(bx.id) === 1 || bx.name === "Match Winner";
  }) as { values?: unknown[] } | undefined;
  if (!bet || !Array.isArray(bet.values)) return null;

  let home: number | null = null;
  let draw: number | null = null;
  let away: number | null = null;
  for (const v of bet.values) {
    const val = v as { value?: unknown; odd?: unknown };
    const label = String(val.value ?? "");
    const odd = num(val.odd);
    if (label === "Home") home = odd;
    else if (label === "Draw") draw = odd;
    else if (label === "Away") away = odd;
  }

  if (home === null || draw === null || away === null) return null;
  return { bookmaker: String(b.name ?? ""), odds: { home, draw, away } };
}
