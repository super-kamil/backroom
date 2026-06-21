/**
 * resolve-fixture.ts — deterministic natural-language → fixture id resolver.
 *
 *   bun run src/scripts/resolve-fixture.ts "<query>" [--date YYYY-MM-DD] [--days N]
 *
 * Turns a human description like "belgium vs iran" (optionally for a given day)
 * into a concrete API-Football fixture id, so /analyze-match can be driven by team
 * names instead of a hand-found id. This is the DETERMINISTIC front door to the
 * chain: the network access stays inside api-client.ts (`searchFixturesByDate`)
 * and the matching is pure + unit-tested (fixture-match.ts). NO LLM judgment here.
 *
 * It prints a human-readable summary plus a machine-readable JSON line, and exits
 * with a code the orchestrating skill branches on:
 *   0  ok         — exactly one fixture matched; resolved.id is the fixture id
 *   2  ambiguous  — several matched; candidates[] are listed for a human to pick
 *   3  none        — no fixture matched the query in the searched date window
 *   1  usage/error — bad args, bad date, or empty API key
 *
 * --date defaults to today (provider timezone = UTC). --days widens the search to
 * N consecutive days from --date (default 1), which also absorbs a kickoff that
 * straddles midnight UTC.
 */

import type { FixtureRef } from "../lib/contracts.ts";
import { API_KEY } from "../lib/config.ts";
import { CACHE_DB_PATH } from "../lib/run-paths.ts";
import { createApiClient } from "../lib/api-client.ts";
import { Cache } from "../lib/cache.ts";
import { matchFixtures } from "../lib/fixture-match.ts";

// ── Exit codes (the orchestrator branches on these) ───────────────────────────
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_AMBIGUOUS = 2;
const EXIT_NONE = 3;

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_USAGE);
}

// ── Date helpers (UTC, no provider-timezone surprises) ────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayISO(): string {
  return formatISO(new Date());
}

function formatISO(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Add `n` whole days to a YYYY-MM-DD string, in UTC. */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return formatISO(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n)));
}

// ── Parse argv: a free-text query plus --date / --days flags ──────────────────
const argv = process.argv.slice(2);
let dateArg: string | undefined;
let days = 1;
const queryParts: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === undefined) continue;
  if (a === "--date") {
    dateArg = argv[++i];
  } else if (a.startsWith("--date=")) {
    dateArg = a.slice("--date=".length);
  } else if (a === "--days") {
    days = Number(argv[++i]);
  } else if (a.startsWith("--days=")) {
    days = Number(a.slice("--days=".length));
  } else {
    queryParts.push(a);
  }
}

const query = queryParts.join(" ").trim();
if (query === "") {
  fail(
    'usage: bun run src/scripts/resolve-fixture.ts "<teamA> vs <teamB>" [--date YYYY-MM-DD] [--days N]',
  );
}
if (!Number.isInteger(days) || days < 1) {
  fail(`invalid --days "${days}" — expected a positive integer`);
}

const startDate = dateArg ?? todayISO();
if (!DATE_RE.test(startDate)) {
  fail(`invalid --date "${startDate}" — expected YYYY-MM-DD`);
}

if (API_KEY === "") {
  fail(
    "API_FOOTBALL_KEY is not set — add it to your .env before resolving fixtures.",
  );
}

// ── Fetch the day window and resolve ──────────────────────────────────────────
const cache = new Cache(CACHE_DB_PATH);
const api = createApiClient({ cache });

const searchedDates: string[] = [];
const all: FixtureRef[] = [];
const seen = new Set<number>();

for (let i = 0; i < days; i++) {
  const dISO = addDays(startDate, i);
  searchedDates.push(dISO);
  const fixtures = await api.searchFixturesByDate(dISO, { fresh: true });
  for (const f of fixtures) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      all.push(f);
    }
  }
}

cache.close();

const result = matchFixtures(all, query);

// ── Report: human lines to stderr, machine JSON to stdout, branchable exit code ─
const describe = (f: FixtureRef): string =>
  `  ${f.id}  ${f.home.name} vs ${f.away.name}  [${f.league.name} ${f.league.season}]  ${f.date}  (${f.status})`;

const window =
  searchedDates.length === 1
    ? searchedDates[0]
    : `${searchedDates[0]} … ${searchedDates[searchedDates.length - 1]}`;

console.error(
  `resolve "${query}" over ${window} — scanned ${all.length} fixtures, ${result.candidates.length} match(es)`,
);

if (result.status === "ok" && result.resolved !== null) {
  console.error("matched:");
  console.error(describe(result.resolved));
} else if (result.status === "ambiguous") {
  console.error("ambiguous — candidates:");
  for (const f of result.candidates) console.error(describe(f));
} else {
  console.error("no fixture matched that description in the searched window.");
}

// Machine-readable result for the orchestrator (stdout, single JSON object).
console.log(
  JSON.stringify({
    status: result.status,
    query,
    searchedDates,
    fixtureId: result.resolved?.id ?? null,
    resolved: result.resolved,
    candidates: result.candidates,
  }),
);

process.exit(
  result.status === "ok"
    ? EXIT_OK
    : result.status === "ambiguous"
      ? EXIT_AMBIGUOUS
      : EXIT_NONE,
);
