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

/**
 * Minimum matches played on BOTH the home team's home side and the away team's
 * away side for the season baseline to count as available. A single match is not
 * a baseline; kept modest (3) so genuine season aggregates — and the Belgium
 * case (home=5, away=8) — still clear the bar.
 */
export const MIN_BASELINE_MATCHES = 3;

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
    bundle.baseline.home.matchesPlayed >= MIN_BASELINE_MATCHES &&
    bundle.baseline.away.matchesPlayed >= MIN_BASELINE_MATCHES &&
    bundle.baseline.league.avgHomeGoals > 0 &&
    bundle.baseline.league.avgAwayGoals > 0;
  const coverageChecked =
    bundle.coverage !== undefined && bundle.coverage !== null;

  // missing = whatever prefetch already flagged, plus any failed check here.
  const missing = [...bundle.missing];
  if (!oddsAvailable) missing.push("odds:consensus");
  if (!sufficientHomeForm) missing.push("form:home (insufficient fixtures)");
  if (!sufficientAwayForm) missing.push("form:away (insufficient fixtures)");
  if (!baselineAvailable)
    missing.push("baseline (season rates / league averages)");
  if (!coverageChecked) missing.push("coverage");

  const gate: DataQualityResult["gate"] =
    oddsAvailable &&
    baselineAvailable &&
    sufficientHomeForm &&
    sufficientAwayForm
      ? "pass"
      : "fail";

  const nothingMissing = missing.length === 0;
  const bothWindowsFull =
    homeForm >= FULL_FORM_WINDOW && awayForm >= FULL_FORM_WINDOW;

  let inputConfidence: DataQualityResult["inputConfidence"];
  if (nothingMissing && bothWindowsFull) inputConfidence = "high";
  else if (gate === "pass") inputConfidence = "medium";
  else inputConfidence = "low";

  // The LIVE recent-form fallback baseline is a documented-as-weak proxy (not
  // opposition-adjusted, neutral-venue/data-thin). It must NOT be promoted to
  // the highest tier: cap it at "medium". The gate still PASSES — live mode is
  // designed to proceed with tempered confidence, not to fail here.
  const baselineFromFormFallback = bundle.baselineSource === "form-fallback";
  if (baselineFromFormFallback && inputConfidence === "high") {
    inputConfidence = "medium";
  }

  const formFallbackNote = baselineFromFormFallback
    ? " Baseline derived from recent-form proxy (neutral-venue/data-thin) — confidence capped at medium."
    : "";

  const reason =
    gate === "pass"
      ? `Inputs sufficient: odds present, baseline present, form windows home=${homeForm}/away=${awayForm} (>= ${MIN_FIXTURES}). Confidence ${inputConfidence}.` +
        (nothingMissing ? "" : ` Minor gaps: ${missing.join(", ")}.`) +
        formFallbackNote
      : `Inputs insufficient — gate FAIL. Missing/failed: ${missing.join(", ") || "unknown"}.` +
        formFallbackNote;

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
