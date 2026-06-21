/**
 * capability.ts — deterministic startup capability check (runs before any LLM).
 *
 * Verifies that the configured LEAGUE_ID / SEASON and the endpoints the current
 * MODE needs are actually accessible on the active API plan, and FAILS FAST —
 * naming exactly what is blocked — without spending a single model token.
 *
 *   bun run src/scripts/capability.ts                 # uses config defaults
 *   bun run src/scripts/capability.ts <leagueId> <season>   # probe an override
 *
 * Required endpoints by mode:
 *   validation → fixtures, odds   (baseline + form are derived AS-OF from the
 *                season's finished fixtures, so /teams/statistics and /standings
 *                are NOT needed; odds power the historical value P&L)
 *   live       → fixtures, statistics, standings, odds  (+ season accessible)
 *
 * Exit 0 = all required endpoints accessible; exit 1 = something is blocked.
 */

import {
  API_BASE_URL,
  API_KEY,
  MODE,
  LEAGUE_ID,
  SEASON,
} from "../lib/config.ts";

if (!API_KEY) {
  console.error(
    "API_FOOTBALL_KEY is empty — set it in .env before the capability check.",
  );
  process.exit(1);
}

const leagueId = Number(process.argv[2] ?? LEAGUE_ID);
const season = Number(process.argv[3] ?? SEASON);

interface ApiResult {
  results: number;
  errors: Record<string, string> | unknown[];
  response: unknown[];
}

async function get(path: string): Promise<ApiResult> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "x-apisports-key": API_KEY },
  });
  const j = (await res.json()) as ApiResult;
  return j;
}

/** Returns a plan/auth error string if the response carries one, else null. */
function planError(r: ApiResult): string | null {
  const e = r.errors;
  if (Array.isArray(e)) return null;
  if (e && typeof e === "object") {
    const obj = e as Record<string, string>;
    const key = Object.keys(obj)[0];
    if (key !== undefined) return `${key}: ${obj[key]}`;
  }
  return null;
}

type Check = { name: string; ok: boolean; detail: string; required: boolean };
const checks: Check[] = [];

console.log(
  `Capability check — league=${leagueId} season=${season} mode=${MODE}`,
);
console.log(`provider=${API_BASE_URL}\n`);

// 0) League + season existence and coverage flags (informational).
const leagues = await get(`/leagues?id=${leagueId}`);
const lerr = planError(leagues);
const leagueRow = (leagues.response[0] ?? null) as {
  league?: { name?: string };
  seasons?: Array<{ year: number; coverage?: unknown }>;
} | null;
const seasonRow = leagueRow?.seasons?.find((s) => s.year === season) ?? null;
console.log(
  `league: ${leagueRow?.league?.name ?? "(unknown)"} | season ${season} listed: ${seasonRow ? "yes" : "no"}`,
);
if (lerr) console.log(`  /leagues note: ${lerr}`);
if (seasonRow?.coverage)
  console.log(`  coverage flags: ${JSON.stringify(seasonRow.coverage)}`);
console.log("");

// 1) fixtures (by league+season — powers form-by-season; avoids the paid `last` param)
const fixtures = await get(`/fixtures?league=${leagueId}&season=${season}`);
const fxErr = planError(fixtures);
checks.push({
  name: "fixtures (league+season)",
  ok: fxErr === null && fixtures.results > 0,
  detail: fxErr ?? `${fixtures.results} fixtures`,
  required: true,
});

// Grab a team id from the fixtures to probe team statistics.
let teamId: number | null = null;
const firstFixture = fixtures.response[0] as
  | { teams?: { home?: { id?: number } } }
  | undefined;
if (firstFixture?.teams?.home?.id) teamId = firstFixture.teams.home.id;

// 2) standings + team statistics — LIVE only (validation derives the baseline
//    AS-OF from finished fixtures, so it needs neither).
if (MODE === "live") {
  const standings = await get(`/standings?league=${leagueId}&season=${season}`);
  const stErr = planError(standings);
  checks.push({
    name: "standings (live)",
    ok: stErr === null && standings.results > 0,
    detail: stErr ?? `${standings.results} table(s)`,
    required: true,
  });

  if (teamId !== null) {
    const stats = await get(
      `/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`,
    );
    const statErr = planError(stats);
    // /teams/statistics returns a single object in `response` (not an array) when
    // accessible; a plan block surfaces in `errors`.
    checks.push({
      name: `team statistics (team ${teamId}, live)`,
      ok: statErr === null && stats.response != null,
      detail: statErr ?? "accessible",
      required: true,
    });
  } else {
    checks.push({
      name: "team statistics (live)",
      ok: false,
      detail: "could not derive a team id (fixtures empty/blocked)",
      required: true,
    });
  }
}

// 3) odds — required in BOTH modes (live pricing; historical value P&L in validation)
const odds = await get(`/odds?league=${leagueId}&season=${season}`);
const oErr = planError(odds);
checks.push({
  name: `odds (${MODE})`,
  ok: oErr === null && odds.results > 0,
  detail: oErr ?? `${odds.results} odds rows`,
  required: true,
});

// ── Report ───────────────────────────────────────────────────────────────────
console.log("Endpoint accessibility:");
for (const c of checks) {
  const mark = c.ok ? "PASS" : c.required ? "FAIL" : "warn";
  console.log(`  [${mark}] ${c.name} — ${c.detail}`);
}

const blocked = checks.filter((c) => c.required && !c.ok);
console.log("");
if (blocked.length === 0) {
  console.log(
    `CAPABILITY OK — league ${leagueId} / season ${season} supports ${MODE} mode.`,
  );
  process.exit(0);
} else {
  console.log(
    `CAPABILITY FAIL — ${MODE} mode needs: ${blocked.map((c) => c.name).join(", ")}.`,
  );
  console.log(
    "Pick a season your plan unlocks (validation), or upgrade the plan (live).",
  );
  process.exit(1);
}
