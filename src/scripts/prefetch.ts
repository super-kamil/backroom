/**
 * prefetch.ts — the deterministic, network-bound prefetch stage.
 *
 *   bun run src/scripts/prefetch.ts <fixtureId>
 *
 * Pulls everything the agents need from API-Football into a single
 * PrefetchBundle, respecting per-league coverage flags so we never call an
 * endpoint the provider says is unavailable. Anything missing or null is
 * recorded in missing[] and the run continues (graceful degradation) rather
 * than crashing. It then runs the Data Quality Gate and writes both artifacts
 * into the per-match run directory. The verdict lives in gate.json — this
 * script ALWAYS exits 0 once it gets past the fatal preconditions, so the
 * orchestrating skill reads the gate file rather than the exit code.
 *
 * MODE BRANCH (the determinism/no-lookahead boundary):
 *   - live       → season-to-date /teams/statistics + /standings + last-N form +
 *                  FRESH odds. Correct for an UPCOMING fixture.
 *   - validation → an AS-OF-KICKOFF reconstruction for a COMPLETED season: the
 *                  baseline and form are derived from ONLY the matches that kicked
 *                  off BEFORE this fixture (computeBaselineFromFixtures /
 *                  getRecentFormBySeason with beforeDate=kickoff). It never reads a
 *                  season-to-date aggregate — that already contains this match and
 *                  every later one, which would leak the future into the estimate.
 *                  Historical odds (immutable) are served from the STABLE cache.
 */

import { mkdirSync, rmSync } from "node:fs";

import type { PrefetchBundle } from "../lib/contracts.ts";
import { API_KEY, MODE, FORM_WINDOW } from "../lib/config.ts";
import { runDir, runPath, CACHE_DB_PATH } from "../lib/run-paths.ts";
import { createApiClient } from "../lib/api-client.ts";
import { Cache } from "../lib/cache.ts";
import {
  computeBaselineFromFixtures,
  computeBaselineFromForm,
} from "../lib/historical-baseline.ts";
import { evaluateGate } from "../lib/data-quality-gate.ts";

const arg = process.argv[2];
if (arg === undefined || arg === "") {
  console.error("usage: bun run src/scripts/prefetch.ts <fixtureId>");
  process.exit(1);
}

const fixtureId = Number(arg);
if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
  console.error(`invalid fixtureId "${arg}" — expected a positive integer`);
  process.exit(1);
}

if (API_KEY === "") {
  console.error(
    "API_FOOTBALL_KEY is not set — add it to your .env before prefetching.",
  );
  process.exit(1);
}

// ── 0. Run hygiene — start from a clean run directory ─────────────────────────
// Wipe runs/<id>/ before writing anything, so stale artifacts from a prior or
// partial run (old agent reports, *-math.json, decision.json) can't leak into
// this fresh run and manufacture false "convergence". Robust if the dir is
// absent yet (recursive + force never throws on a missing path).
const dir = runDir(fixtureId);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const cache = new Cache(CACHE_DB_PATH);
const api = createApiClient({ cache });

const missing: string[] = [];
const dataTimestamps: Record<string, string> = {};
/** Record a fetch timestamp for a named source. */
const stamp = (source: string): void => {
  dataTimestamps[source] = new Date().toISOString();
};

// ── 1. Fixture (fatal if absent — nothing else makes sense without it) ────────
const fixture = await api.getFixture(fixtureId);
if (fixture === null) {
  console.error(`no fixture found for id ${fixtureId} — cannot prefetch.`);
  process.exit(1);
}
stamp("fixture");

// ── 2. Coverage (drives every downstream decision) ────────────────────────────
const coverage = await api.getCoverage(
  fixture.league.id,
  fixture.league.season,
);
if (coverage === null) {
  missing.push("coverage");
} else {
  stamp("coverage");
}

// ── 3. Form + baseline — sourced by MODE. Degrade gracefully either way ───────
let homeForm = { windowSize: 0, matches: [] } as PrefetchBundle["form"]["home"];
let awayForm = { windowSize: 0, matches: [] } as PrefetchBundle["form"]["away"];
let baselineHome: PrefetchBundle["baseline"]["home"] = {
  matchesPlayed: 0,
  goalsForPerHome: 0,
  goalsAgainstPerHome: 0,
};
let baselineAway: PrefetchBundle["baseline"]["away"] = {
  matchesPlayed: 0,
  goalsForPerAway: 0,
  goalsAgainstPerAway: 0,
};
let leagueAverages: PrefetchBundle["baseline"]["league"] = {
  avgHomeGoals: 0,
  avgAwayGoals: 0,
};
// Tracks how the baseline was derived. Flips to "form-fallback" only when the
// LIVE recent-form proxy fires below; otherwise it stays "season". The gate
// caps confidence to at most "medium" on the form-fallback path.
let baselineSource: PrefetchBundle["baselineSource"] = "season";

if (MODE === "validation") {
  // AS-OF-KICKOFF reconstruction — NO LOOKAHEAD. Everything is derived from the
  // season's finished fixtures that kicked off strictly before this match.
  const matchDate = fixture.date;
  if (coverage && coverage.fixtures) {
    const results = await api.getLeagueSeasonResults(
      fixture.league.id,
      fixture.league.season,
    );
    stamp("season-results");

    const asOf = computeBaselineFromFixtures(
      results,
      fixture.home.id,
      fixture.away.id,
      matchDate,
    );
    if (asOf === null) {
      missing.push("baseline (insufficient prior matches as-of kickoff)");
    } else {
      baselineHome = asOf.home;
      baselineAway = asOf.away;
      leagueAverages = asOf.league;
      stamp("baseline");
    }

    homeForm = await api.getRecentFormBySeason(
      fixture.home.id,
      fixture.league.id,
      fixture.league.season,
      FORM_WINDOW,
      matchDate,
    );
    awayForm = await api.getRecentFormBySeason(
      fixture.away.id,
      fixture.league.id,
      fixture.league.season,
      FORM_WINDOW,
      matchDate,
    );
    stamp("form");
    if (homeForm.matches.length === 0) missing.push("form:home");
    if (awayForm.matches.length === 0) missing.push("form:away");
  } else {
    missing.push("season-results (fixtures coverage unavailable)");
    missing.push("form:home (fixtures coverage unavailable)");
    missing.push("form:away (fixtures coverage unavailable)");
    missing.push("baseline (fixtures coverage unavailable)");
  }
} else {
  // LIVE: season-to-date aggregates for an upcoming fixture.
  // Short-window form (last 10) for each team. Gated on fixtures coverage.
  if (coverage && coverage.fixtures) {
    homeForm = await api.getRecentForm(fixture.home.id, 10);
    awayForm = await api.getRecentForm(fixture.away.id, 10);
    stamp("form");
    if (homeForm.matches.length === 0) missing.push("form:home");
    if (awayForm.matches.length === 0) missing.push("form:away");
  } else {
    missing.push("form:home (fixtures coverage unavailable)");
    missing.push("form:away (fixtures coverage unavailable)");
  }

  // Season-long baseline rates per team. Gated on statistics coverage.
  if (coverage && coverage.statistics) {
    const home = await api.getBaseline(
      fixture.home.id,
      fixture.league.id,
      fixture.league.season,
    );
    const away = await api.getBaseline(
      fixture.away.id,
      fixture.league.id,
      fixture.league.season,
    );
    stamp("baseline");
    if (home === null) missing.push("baseline:home");
    else baselineHome = home.home;
    if (away === null) missing.push("baseline:away");
    else baselineAway = away.away;
  } else {
    missing.push("baseline:home (statistics coverage unavailable)");
    missing.push("baseline:away (statistics coverage unavailable)");
  }

  // League average goals. Gated on standings coverage.
  if (coverage && coverage.standings) {
    const league = await api.getLeagueAverages(
      fixture.league.id,
      fixture.league.season,
    );
    if (league === null) {
      missing.push("baseline:league");
    } else {
      leagueAverages = league;
      stamp("league-averages");
    }
  } else {
    missing.push("baseline:league (standings coverage unavailable)");
  }

  // FALLBACK — neutral-venue / data-thin competitions (e.g. an in-progress World
  // Cup) have no usable within-competition season aggregate this early: a team
  // may have 0 away games, and tournament standings carry no home/away split. When
  // the season aggregate can't satisfy the gate, derive the baseline from each
  // team's recent form ACROSS ALL competitions (qualifiers, friendlies, etc.) so
  // the chain can still price the match. Less calibrated than a league aggregate —
  // a deliberate, stamped relaxation; the Sharp is expected to flag soft form.
  const seasonBaselineUsable =
    baselineHome.matchesPlayed > 0 &&
    baselineAway.matchesPlayed > 0 &&
    leagueAverages.avgHomeGoals > 0 &&
    leagueAverages.avgAwayGoals > 0;
  if (!seasonBaselineUsable) {
    const formBaseline = computeBaselineFromForm(homeForm, awayForm);
    if (formBaseline !== null) {
      baselineHome = formBaseline.home;
      baselineAway = formBaseline.away;
      leagueAverages = formBaseline.league;
      // Mark the baseline as the soft recent-form proxy so the gate can cap
      // confidence — it must never be promoted to the "high" tier.
      baselineSource = "form-fallback";
      // Drop any season-baseline gaps now satisfied by the recent-form proxy.
      for (const tag of ["baseline:home", "baseline:away", "baseline:league"]) {
        const i = missing.indexOf(tag);
        if (i !== -1) missing.splice(i, 1);
      }
      stamp("baseline-form-fallback");
    }
  }
}

// ── 4. Odds — gated on odds coverage. Live = FRESH; validation = cached (a
//        completed season's odds are immutable, so cache to spare the rate limit).
let odds: PrefetchBundle["odds"] = {
  bookmakers: [],
  consensus: { home: 0, draw: 0, away: 0 },
};
if (coverage && coverage.odds) {
  const fetched = await api.getOdds(fixtureId, {
    fresh: MODE !== "validation",
  });
  if (fetched === null) {
    missing.push("odds");
  } else {
    odds = fetched;
    stamp("odds");
  }
} else {
  missing.push("odds (odds coverage unavailable)");
}

// ── 5. API-Football's own model — optional cross-check only. Gated on predictions.
let apiPredictions: PrefetchBundle["apiPredictions"];
if (coverage && coverage.predictions) {
  const preds = await api.getApiPredictions(fixtureId);
  if (preds === null) {
    missing.push("apiPredictions");
  } else {
    apiPredictions = preds;
    stamp("apiPredictions");
  }
} else {
  missing.push("apiPredictions (predictions coverage unavailable)");
}

// ── 6. Assemble the bundle and persist it ─────────────────────────────────────
const bundle: PrefetchBundle = {
  fixture,
  // Coverage is non-null here only when fetched; default to all-false otherwise
  // so the gate's coverageChecked still sees a structured object.
  coverage: coverage ?? {
    fixtures: false,
    statistics: false,
    standings: false,
    odds: false,
    predictions: false,
    lineups: false,
    injuries: false,
  },
  form: { home: homeForm, away: awayForm },
  baseline: { home: baselineHome, away: baselineAway, league: leagueAverages },
  baselineSource,
  odds,
  apiPredictions,
  dataTimestamps,
  missing,
};

// Dir already created in step 0; ensure it once more (idempotent) in case a
// later refactor moves the hygiene step.
mkdirSync(dir, { recursive: true });
await Bun.write(
  runPath(fixtureId, "prefetch"),
  JSON.stringify(bundle, null, 2),
);

// ── 7. Run the Data Quality Gate and persist its verdict ──────────────────────
const gate = evaluateGate(bundle);
await Bun.write(runPath(fixtureId, "gate"), JSON.stringify(gate, null, 2));

// ── 8. One-line summary; always exit 0 (verdict lives in gate.json) ───────────
const missingSummary =
  gate.missing.length > 0 ? ` | missing: ${gate.missing.join(", ")}` : "";
console.log(
  `[${MODE}] gate ${gate.gate === "pass" ? "PASS" : "FAIL"}${missingSummary}`,
);

cache.close();
process.exit(0);
