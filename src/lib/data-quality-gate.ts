/**
 * data-quality-gate.ts — the deterministic Data Quality Gate.
 *
 * Runs after prefetch and before any agent or recommendation. It inspects the
 * PrefetchBundle and decides whether the inputs are good enough to proceed. A
 * "fail" verdict short-circuits the pipeline into a NO-BET; a "pass" still
 * carries an inputConfidence so downstream agents can temper their certainty.
 *
 * Pure function, no I/O — fully unit-testable.
 */

import type { DataQualityResult, PrefetchBundle } from "./contracts.ts";

/** Minimum resolved fixtures in a form window for it to be "sufficient". */
export const MIN_FIXTURES = 5;

/** A "full" form window — drives the high-confidence threshold. */
const FULL_FORM_WINDOW = 8;

/** All three decimal odds present and strictly greater than an even-money 1.0. */
function oddsOk(bundle: PrefetchBundle): boolean {
  const c = bundle.odds?.consensus;
  if (!c) return false;
  return c.home > 1 && c.draw > 1 && c.away > 1;
}

export function evaluateGate(bundle: PrefetchBundle): DataQualityResult {
  const homeForm = bundle.form.home.matches.length;
  const awayForm = bundle.form.away.matches.length;

  const oddsAvailable = oddsOk(bundle);
  const sufficientHomeForm = homeForm >= MIN_FIXTURES;
  const sufficientAwayForm = awayForm >= MIN_FIXTURES;
  const baselineAvailable =
    bundle.baseline.home.matchesPlayed > 0 &&
    bundle.baseline.away.matchesPlayed > 0 &&
    bundle.baseline.league.avgHomeGoals > 0 &&
    bundle.baseline.league.avgAwayGoals > 0;
  const coverageChecked = bundle.coverage !== undefined && bundle.coverage !== null;

  // missing = whatever prefetch already flagged, plus any failed check here.
  const missing = [...bundle.missing];
  if (!oddsAvailable) missing.push("odds:consensus");
  if (!sufficientHomeForm) missing.push("form:home (insufficient fixtures)");
  if (!sufficientAwayForm) missing.push("form:away (insufficient fixtures)");
  if (!baselineAvailable) missing.push("baseline (season rates / league averages)");
  if (!coverageChecked) missing.push("coverage");

  const gate: DataQualityResult["gate"] =
    oddsAvailable && baselineAvailable && sufficientHomeForm && sufficientAwayForm
      ? "pass"
      : "fail";

  const nothingMissing = missing.length === 0;
  const bothWindowsFull =
    homeForm >= FULL_FORM_WINDOW && awayForm >= FULL_FORM_WINDOW;

  let inputConfidence: DataQualityResult["inputConfidence"];
  if (nothingMissing && bothWindowsFull) inputConfidence = "high";
  else if (gate === "pass") inputConfidence = "medium";
  else inputConfidence = "low";

  const reason =
    gate === "pass"
      ? `Inputs sufficient: odds present, baseline present, form windows home=${homeForm}/away=${awayForm} (>= ${MIN_FIXTURES}). Confidence ${inputConfidence}.` +
        (nothingMissing ? "" : ` Minor gaps: ${missing.join(", ")}.`)
      : `Inputs insufficient — gate FAIL. Missing/failed: ${missing.join(", ") || "unknown"}.`;

  return {
    gate,
    checks: {
      oddsAvailable,
      sufficientHomeForm,
      sufficientAwayForm,
      baselineAvailable,
      coverageChecked,
    },
    missing,
    inputConfidence,
    reason,
  };
}
