/**
 * validators.ts — the deterministic backpressure layer.
 *
 * Every agent's JSON output passes through here BEFORE it is accepted
 * downstream. This is the factory's equivalent of a linter / type-checker: a
 * pure, hand-written gate that an agent must clear or be sent back to fix. NO
 * I/O, NO network. `data` is `unknown` on purpose — the whole point is to make
 * no assumptions about what the agent actually produced.
 *
 * Three layers in validateReport, all checked (we never bail on the first error
 * so a retry can fix everything at once):
 *   1. SCHEMA   — required fields present with correct types/shapes.
 *   2. BOUNDS   — probabilities in [0,1], triples sum to ~1, λ/stake/etc sane.
 *   3. CONSISTENCY — cross-field invariants (edge === ourProb − fairProb, …).
 *
 * A FOURTH layer lives in the crossCheck* functions below (applied by
 * `validate.ts`, which supplies the deterministic `*-math.json` source): the
 * numbers an agent copied must EQUAL the script-computed ones, not merely be
 * in-bounds. That is what makes the determinism boundary mechanical — a
 * within-bounds altered probability fails the cross-check.
 *
 * MVP MARKET: 1X2 only.
 */

import type {
  Outcome,
  OutcomeOdds,
  OutcomeProbs,
  FormScoutReport,
  QuantMath,
  QuantReport,
  TraderReport,
  RiskReport,
  SharpReport,
  FinalDecision,
} from "./contracts.ts";
import { BANKROLL, MAX_STAKE } from "./config.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// Quant λ sane range: a strictly-positive expected-goals figure with a generous
// upper bound. (0, 8] per spec.
const LAMBDA_MAX = 8;

const OUTCOMES: readonly Outcome[] = ["home", "draw", "away"];

// ─────────────────────────────────────────────────────────────────────────────
// Reusable numeric helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A finite number in [0,1]. */
export function isProb(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

/** True when a probability triple sums to ~1 within tolerance (default 0.02). */
export function sumsToOne(triple: OutcomeProbs, tol = 0.02): boolean {
  return Math.abs(triple.home + triple.draw + triple.away - 1) <= tol;
}

/** Float equality within an epsilon (default 1e-6). */
export function approxEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small internal shape guards (collect-style: push into an errors array)
// ─────────────────────────────────────────────────────────────────────────────

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Validate that `v` is an OutcomeProbs-shaped object; returns it or undefined. */
function asOutcomeProbs(
  v: unknown,
  field: string,
  errors: string[],
): OutcomeProbs | undefined {
  if (!isObject(v)) {
    errors.push(`${field}: expected an object with home/draw/away numbers`);
    return undefined;
  }
  let ok = true;
  for (const k of OUTCOMES) {
    if (!isFiniteNumber(v[k])) {
      errors.push(`${field}.${k}: expected a finite number`);
      ok = false;
    }
  }
  if (!ok) return undefined;
  return { home: v.home as number, draw: v.draw as number, away: v.away as number };
}

/** Check every member of a triple is a valid probability in [0,1]. */
function checkProbTriple(t: OutcomeProbs, field: string, errors: string[]): void {
  for (const k of OUTCOMES) {
    if (!isProb(t[k])) errors.push(`${field}.${k}: probability must be in [0,1]`);
  }
}

function requireString(v: unknown, field: string, errors: string[]): void {
  if (typeof v !== "string") errors.push(`${field}: expected a string`);
}

function requireOneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  field: string,
  errors: string[],
): void {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    errors.push(`${field}: must be one of ${allowed.join(" | ")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-agent validators
// ─────────────────────────────────────────────────────────────────────────────

const TRENDS = ["improving", "declining", "stable"] as const;

function checkTeamFormView(v: unknown, field: string, errors: string[]): void {
  if (!isObject(v)) {
    errors.push(`${field}: expected a TeamFormView object`);
    return;
  }
  requireOneOf(v.trend, TRENDS, `${field}.trend`, errors);
  if (!isProb(v.formQuality)) {
    errors.push(`${field}.formQuality: must be in [0,1]`);
  }
  requireString(v.qualityOfOpposition, `${field}.qualityOfOpposition`, errors);
  requireString(v.summary, `${field}.summary`, errors);
  if (
    !Array.isArray(v.notableSignals) ||
    !v.notableSignals.every((s) => typeof s === "string")
  ) {
    errors.push(`${field}.notableSignals: expected an array of strings`);
  }
}

function validateFormScout(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ["form-scout: report must be an object"];
  const d = data as Partial<FormScoutReport> & Record<string, unknown>;

  if (d.agent !== "form-scout") errors.push('agent: must be "form-scout"');
  checkTeamFormView(d.home, "home", errors);
  checkTeamFormView(d.away, "away", errors);
  if (!isProb(d.confidence)) errors.push("confidence: must be in [0,1]");
  requireString(d.notes, "notes", errors);
  return errors;
}

function validateQuant(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ["quant: report must be an object"];
  const d = data as Record<string, unknown>;

  if (d.agent !== "quant") errors.push('agent: must be "quant"');

  // math block
  let probs: OutcomeProbs | undefined;
  const math = d.math;
  if (!isObject(math)) {
    errors.push("math: expected a QuantMath object");
  } else {
    const lambda = math.lambda;
    if (!isObject(lambda)) {
      errors.push("math.lambda: expected { home, away } numbers");
    } else {
      for (const side of ["home", "away"] as const) {
        const l = lambda[side];
        if (!isFiniteNumber(l)) {
          errors.push(`math.lambda.${side}: expected a finite number`);
        } else if (!(l > 0 && l <= LAMBDA_MAX)) {
          errors.push(`math.lambda.${side}: must be in (0, ${LAMBDA_MAX}]`);
        }
      }
    }

    probs = asOutcomeProbs(math.probs, "math.probs", errors);
    if (probs) {
      checkProbTriple(probs, "math.probs", errors);
      if (!sumsToOne(probs)) errors.push("math.probs: must sum to ~1 (±0.02)");
    }

    // scorelineTopN: each prob in [0,1], descending order
    const topN = math.scorelineTopN;
    if (!Array.isArray(topN)) {
      errors.push("math.scorelineTopN: expected an array");
    } else {
      let prev = Infinity;
      for (let i = 0; i < topN.length; i++) {
        const s = topN[i];
        if (!isObject(s)) {
          errors.push(`math.scorelineTopN[${i}]: expected an object`);
          continue;
        }
        if (!Number.isInteger(s.home) || !Number.isInteger(s.away)) {
          errors.push(`math.scorelineTopN[${i}]: home/away must be integers`);
        }
        if (!isProb(s.prob)) {
          errors.push(`math.scorelineTopN[${i}].prob: must be in [0,1]`);
        } else {
          if (s.prob > prev + 1e-9) {
            errors.push(
              `math.scorelineTopN[${i}]: not sorted descending by prob`,
            );
          }
          prev = s.prob;
        }
      }
    }

    requireString(math.mathVersion, "math.mathVersion", errors);
  }

  // crossCheck
  const cc = d.crossCheck;
  if (!isObject(cc)) {
    errors.push("crossCheck: expected an object");
  } else {
    if (cc.source !== "api-football-predictions") {
      errors.push('crossCheck.source: must be "api-football-predictions"');
    }
    requireOneOf(
      cc.agreement,
      ["aligned", "diverges", "unavailable"] as const,
      "crossCheck.agreement",
      errors,
    );
    if (cc.probs !== undefined) {
      const ccp = asOutcomeProbs(cc.probs, "crossCheck.probs", errors);
      if (ccp) checkProbTriple(ccp, "crossCheck.probs", errors);
    }
  }

  // sanityChecks
  const sc = d.sanityChecks;
  if (!isObject(sc)) {
    errors.push("sanityChecks: expected an object");
  } else {
    if (typeof sc.sumsToOne !== "boolean") {
      errors.push("sanityChecks.sumsToOne: expected a boolean");
    }
    if (typeof sc.lambdaInRange !== "boolean") {
      errors.push("sanityChecks.lambdaInRange: expected a boolean");
    }
    requireString(sc.notes, "sanityChecks.notes", errors);
  }

  if (!isProb(d.confidence)) errors.push("confidence: must be in [0,1]");
  requireString(d.notes, "notes", errors);
  return errors;
}

function validateTrader(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ["trader: report must be an object"];
  const d = data as Record<string, unknown>;

  if (d.agent !== "trader") errors.push('agent: must be "trader"');

  const rawOdds = asOutcomeProbs(d.rawOdds, "rawOdds", errors);
  if (rawOdds) {
    for (const k of OUTCOMES) {
      if (!(rawOdds[k] > 1)) {
        errors.push(`rawOdds.${k}: decimal odds must be > 1`);
      }
    }
  }

  const impliedRaw = asOutcomeProbs(d.impliedRaw, "impliedRaw", errors);
  if (impliedRaw) checkProbTriple(impliedRaw, "impliedRaw", errors);

  if (!isFiniteNumber(d.overround)) {
    errors.push("overround: expected a finite number");
  } else if (d.overround < 0) {
    errors.push("overround: must be >= 0");
  }

  requireOneOf(
    d.deVigMethod,
    ["proportional", "power", "shin"] as const,
    "deVigMethod",
    errors,
  );

  const fairProbs = asOutcomeProbs(d.fairProbs, "fairProbs", errors);
  if (fairProbs) {
    checkProbTriple(fairProbs, "fairProbs", errors);
    if (!sumsToOne(fairProbs)) errors.push("fairProbs: must sum to ~1 (±0.02)");
  }

  if (!isFiniteNumber(d.valueThreshold)) {
    errors.push("valueThreshold: expected a finite number");
  }
  requireString(d.notes, "notes", errors);

  // value map: one entry per outcome with the edge identity enforced.
  const value = d.value;
  const perOutcome: Partial<
    Record<Outcome, { ourProb: number; fairProb: number; edge: number; hasValue: boolean }>
  > = {};
  if (!isObject(value)) {
    errors.push("value: expected a Record<Outcome, …> object");
  } else {
    for (const k of OUTCOMES) {
      const entry = value[k];
      if (!isObject(entry)) {
        errors.push(`value.${k}: expected an object`);
        continue;
      }
      const ourProb = entry.ourProb;
      const fairProb = entry.fairProb;
      const edge = entry.edge;
      const hasValue = entry.hasValue;
      let entryOk = true;
      if (!isProb(ourProb)) {
        errors.push(`value.${k}.ourProb: must be in [0,1]`);
        entryOk = false;
      }
      if (!isProb(fairProb)) {
        errors.push(`value.${k}.fairProb: must be in [0,1]`);
        entryOk = false;
      }
      if (!isFiniteNumber(edge)) {
        errors.push(`value.${k}.edge: expected a finite number`);
        entryOk = false;
      }
      if (typeof hasValue !== "boolean") {
        errors.push(`value.${k}.hasValue: expected a boolean`);
        entryOk = false;
      }
      // CONSISTENCY: edge === ourProb − fairProb.
      if (entryOk) {
        if (!approxEqual(edge as number, (ourProb as number) - (fairProb as number))) {
          errors.push(
            `value.${k}.edge: must equal ourProb − fairProb (got ${edge})`,
          );
        }
        perOutcome[k] = {
          ourProb: ourProb as number,
          fairProb: fairProb as number,
          edge: edge as number,
          hasValue: hasValue as boolean,
        };
      }
    }
  }

  // bestSelection: null, or an outcome that genuinely qualifies.
  const best = d.bestSelection;
  if (best !== null) {
    if (typeof best !== "string" || !OUTCOMES.includes(best as Outcome)) {
      errors.push("bestSelection: must be null or one of home | draw | away");
    } else {
      const entry = perOutcome[best as Outcome];
      const threshold = isFiniteNumber(d.valueThreshold)
        ? d.valueThreshold
        : undefined;
      if (!entry) {
        errors.push(
          `bestSelection: "${best}" has no valid value entry to qualify`,
        );
      } else {
        if (!entry.hasValue) {
          errors.push(`bestSelection: "${best}" must have hasValue === true`);
        }
        if (threshold !== undefined && entry.edge < threshold) {
          errors.push(
            `bestSelection: "${best}" edge ${entry.edge} must be >= valueThreshold ${threshold}`,
          );
        }
      }
    }
  }

  // CONSISTENCY: overround === sum(impliedRaw) − 1.
  if (impliedRaw && isFiniteNumber(d.overround)) {
    const derived = impliedRaw.home + impliedRaw.draw + impliedRaw.away - 1;
    if (!approxEqual(d.overround, derived)) {
      errors.push(
        `overround: must equal sum(impliedRaw) − 1 (expected ${derived})`,
      );
    }
  }

  return errors;
}

function validateRisk(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ["risk-manager: report must be an object"];
  const d = data as Record<string, unknown>;

  if (d.agent !== "risk-manager") errors.push('agent: must be "risk-manager"');

  if (!isFiniteNumber(d.overround)) {
    errors.push("overround: expected a finite number");
  } else if (d.overround < 0) {
    errors.push("overround: must be >= 0");
  }

  if (!isFiniteNumber(d.bankroll)) {
    errors.push("bankroll: expected a finite number");
  } else if (d.bankroll < 0) {
    errors.push("bankroll: must be >= 0");
  }

  if (!isProb(d.stakePct)) errors.push("stakePct: must be in [0,1]");

  if (!isFiniteNumber(d.rawStake)) {
    errors.push("rawStake: expected a finite number");
  } else if (d.rawStake < 0) {
    errors.push("rawStake: must be >= 0");
  }

  // recommendedStake: bounded by [0, MAX_STAKE] and never above the bankroll.
  if (!isFiniteNumber(d.recommendedStake)) {
    errors.push("recommendedStake: expected a finite number");
  } else {
    if (d.recommendedStake < 0 || d.recommendedStake > MAX_STAKE) {
      errors.push(`recommendedStake: must be in [0, ${MAX_STAKE}]`);
    }
    if (d.recommendedStake > BANKROLL) {
      errors.push(`recommendedStake: must be <= bankroll ${BANKROLL}`);
    }
    // …and never above the report's OWN declared bankroll (env override safe).
    if (isFiniteNumber(d.bankroll) && d.recommendedStake > d.bankroll) {
      errors.push(`recommendedStake: must be <= bankroll ${d.bankroll}`);
    }
  }

  if (typeof d.stakeCapped !== "boolean") {
    errors.push("stakeCapped: expected a boolean");
  }

  const rg = d.responsibleGambling;
  if (!isObject(rg)) {
    errors.push("responsibleGambling: expected an object");
  } else {
    if (typeof rg.pass !== "boolean") {
      errors.push("responsibleGambling.pass: expected a boolean");
    }
    if (
      !Array.isArray(rg.warnings) ||
      !rg.warnings.every((w) => typeof w === "string")
    ) {
      errors.push("responsibleGambling.warnings: expected an array of strings");
    }
  }

  requireOneOf(
    d.approval,
    ["approved", "reduced", "rejected"] as const,
    "approval",
    errors,
  );
  requireString(d.notes, "notes", errors);
  return errors;
}

const SHARP_CHALLENGE_TYPES = [
  "recency-bias",
  "small-sample",
  "overrated-favorite",
  "stale-data",
  "market-smarter",
  "draw-underweight",
  "other",
] as const;

function validateSharp(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ["sharp: report must be an object"];
  const d = data as Record<string, unknown>;

  if (d.agent !== "sharp") errors.push('agent: must be "sharp"');

  requireOneOf(
    d.verdict,
    ["agree", "disagree", "uncertain"] as const,
    "verdict",
    errors,
  );
  requireOneOf(
    d.recommendation,
    ["proceed", "reduce-confidence", "no-bet"] as const,
    "recommendation",
    errors,
  );

  const challenges = d.challenges;
  if (!Array.isArray(challenges)) {
    errors.push("challenges: expected an array");
  } else {
    for (let i = 0; i < challenges.length; i++) {
      const c = challenges[i];
      if (!isObject(c)) {
        errors.push(`challenges[${i}]: expected an object`);
        continue;
      }
      requireOneOf(c.type, SHARP_CHALLENGE_TYPES, `challenges[${i}].type`, errors);
      requireOneOf(
        c.severity,
        ["low", "medium", "high"] as const,
        `challenges[${i}].severity`,
        errors,
      );
      requireString(c.argument, `challenges[${i}].argument`, errors);
    }
  }

  requireString(d.notes, "notes", errors);
  return errors;
}

function validateHeadCoach(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ["head-coach: decision must be an object"];
  const d = data as Record<string, unknown>;

  if (!Number.isInteger(d.matchId)) errors.push("matchId: expected an integer");
  if (!isObject(d.fixture)) errors.push("fixture: expected a FixtureRef object");

  requireOneOf(
    d.recommendation,
    ["BET", "NO-BET"] as const,
    "recommendation",
    errors,
  );

  requireOneOf(
    d.confidence,
    ["high", "medium", "low"] as const,
    "confidence",
    errors,
  );
  requireString(d.rationale, "rationale", errors);

  // selection: null or a valid outcome.
  const sel = d.selection;
  const selValid =
    sel === null ||
    (typeof sel === "string" && OUTCOMES.includes(sel as Outcome));
  if (!selValid) {
    errors.push("selection: must be null or one of home | draw | away");
  }

  // Numeric fields are number-or-null. Probabilities, when present, are bounded.
  const numericFields = ["ourProb", "fairProb", "edge", "odds", "ev", "stake"] as const;
  for (const f of numericFields) {
    const v = d[f];
    if (v !== null && !isFiniteNumber(v)) {
      errors.push(`${f}: expected a finite number or null`);
    }
  }
  if (d.ourProb !== null && d.ourProb !== undefined && !isProb(d.ourProb)) {
    errors.push("ourProb: must be in [0,1] when present");
  }
  if (d.fairProb !== null && d.fairProb !== undefined && !isProb(d.fairProb)) {
    errors.push("fairProb: must be in [0,1] when present");
  }
  if (
    d.stake !== null &&
    d.stake !== undefined &&
    isFiniteNumber(d.stake) &&
    (d.stake < 0 || d.stake > MAX_STAKE || d.stake > BANKROLL)
  ) {
    errors.push(
      `stake: must be in [0, ${Math.min(MAX_STAKE, BANKROLL)}] when present`,
    );
  }

  // dissent block
  const dissent = d.dissent;
  if (!isObject(dissent)) {
    errors.push("dissent: expected an object");
  } else {
    requireOneOf(
      dissent.sharpVerdict,
      ["agree", "disagree", "uncertain"] as const,
      "dissent.sharpVerdict",
      errors,
    );
    requireString(dissent.divergence, "dissent.divergence", errors);
  }

  if (!isObject(d.dataQuality)) {
    errors.push("dataQuality: expected a DataQualityResult object");
  }
  // `version` is stamped DETERMINISTICALLY by log-prediction.ts (buildVersionStamp),
  // not authored by the agent — so it is optional here. Only reject a malformed
  // one if the agent supplied something non-object.
  if (d.version !== undefined && d.version !== null && !isObject(d.version)) {
    errors.push("version: expected a PipelineVersion object when present");
  }

  // CONSISTENCY: the recommendation drives which fields must be present.
  if (d.recommendation === "BET") {
    const required = ["selection", "ourProb", "fairProb", "odds", "stake"] as const;
    for (const f of required) {
      if (d[f] === null || d[f] === undefined) {
        errors.push(`${f}: must be non-null when recommendation === "BET"`);
      }
    }
    if (
      isFiniteNumber(d.edge) &&
      isFiniteNumber(d.ourProb) &&
      isFiniteNumber(d.fairProb)
    ) {
      if (!approxEqual(d.edge, d.ourProb - d.fairProb)) {
        errors.push("edge: must equal ourProb − fairProb when recommendation === \"BET\"");
      }
    }
  } else if (d.recommendation === "NO-BET") {
    if (d.selection !== null) {
      errors.push('selection: must be null when recommendation === "NO-BET"');
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

type AgentValidator = (data: unknown) => string[];

const VALIDATORS: Record<string, AgentValidator> = {
  "form-scout": validateFormScout,
  quant: validateQuant,
  trader: validateTrader,
  "risk-manager": validateRisk,
  sharp: validateSharp,
  "head-coach": validateHeadCoach,
};

/**
 * Validate an agent's report through the schema / bounds / consistency layers.
 * Returns every error found (never bails early) so one retry can fix all of them.
 */
export function validateReport(
  agent: string,
  data: unknown,
): ValidationResult {
  const validator = VALIDATORS[agent];
  if (!validator) {
    return { ok: false, errors: [`unknown agent "${agent}"`] };
  }
  const errors = validator(data);
  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-checks against the deterministic *-math.json sources
//
// The schema/bounds/consistency layer above proves a report is internally
// well-formed — but an agent re-emits numbers it was handed by a deterministic
// script, and "in-bounds" is not "unaltered". A within-bounds nudge (shaving the
// draw, drifting toward apiPredictions) would pass the layer above. These pure
// functions close that hole: they assert the agent's COPY equals the
// deterministic source value, not merely that it is plausible. `validate.ts`
// reads the source files (it does the I/O) and calls these.
//
// Tolerance is tight: the source value is the SAME number re-serialized through
// JSON, so an honest copy matches to ~15 digits. CROSSCHECK_EPS catches any real
// alteration while ignoring trailing float noise.
// ─────────────────────────────────────────────────────────────────────────────

const CROSSCHECK_EPS = 1e-9;

/** Deterministic de-vig + value math (devig.ts output): TraderReport minus prose. */
export type TraderMath = Omit<TraderReport, "agent" | "notes">;

/** Deterministic stake-sizing math (stake.ts output) — the fields the cross-check reads. */
export interface RiskMath {
  overround: number;
  bankroll: number;
  stakePct: number;
  rawStake: number;
  recommendedStake: number;
  stakeCapped: boolean;
}

/** Assert `a` is a finite number equal to the source `b` within CROSSCHECK_EPS. */
function eqNum(a: unknown, b: number, field: string, errors: string[]): void {
  if (typeof a !== "number" || !Number.isFinite(a) || !approxEqual(a, b, CROSSCHECK_EPS)) {
    errors.push(
      `${field}: must equal the deterministic source value ${b} (got ${String(a)})`,
    );
  }
}

/** Assert an OutcomeProbs/OutcomeOdds triple equals the source triple element-wise. */
function eqTriple(
  a: unknown,
  b: OutcomeProbs | OutcomeOdds,
  field: string,
  errors: string[],
): void {
  if (!isObject(a)) {
    errors.push(`${field}: must equal the deterministic source object`);
    return;
  }
  for (const k of OUTCOMES) eqNum(a[k], b[k], `${field}.${k}`, errors);
}

/**
 * Quant: the embedded `math` block must equal `quant-math.json` verbatim —
 * lambda, the 1X2 probs, the scoreline list, and the math version. This is what
 * stops the LLM from re-emitting an altered probability triple that downstream
 * judgment (and the user-facing report) would then trust.
 */
export function crossCheckQuant(report: unknown, math: QuantMath): string[] {
  const errors: string[] = [];
  if (!isObject(report)) return ["quant: report must be an object"];
  const m = report.math;
  if (!isObject(m)) {
    errors.push("math: must embed the deterministic QuantMath from quant-math.json");
    return errors;
  }

  const lambda = m.lambda;
  if (!isObject(lambda)) {
    errors.push("math.lambda: must equal the deterministic source");
  } else {
    eqNum(lambda.home, math.lambda.home, "math.lambda.home", errors);
    eqNum(lambda.away, math.lambda.away, "math.lambda.away", errors);
  }

  eqTriple(m.probs, math.probs, "math.probs", errors);

  if (m.mathVersion !== math.mathVersion) {
    errors.push(`math.mathVersion: must equal "${math.mathVersion}"`);
  }

  const topN = m.scorelineTopN;
  const ref = math.scorelineTopN;
  if (!Array.isArray(topN) || topN.length !== ref.length) {
    errors.push(
      `math.scorelineTopN: must equal the deterministic source (length ${ref.length})`,
    );
  } else {
    for (let i = 0; i < ref.length; i++) {
      const s = topN[i];
      const r = ref[i];
      if (!r) continue;
      if (!isObject(s)) {
        errors.push(`math.scorelineTopN[${i}]: must equal the deterministic source`);
        continue;
      }
      eqNum(s.home, r.home, `math.scorelineTopN[${i}].home`, errors);
      eqNum(s.away, r.away, `math.scorelineTopN[${i}].away`, errors);
      eqNum(s.prob, r.prob, `math.scorelineTopN[${i}].prob`, errors);
    }
  }

  return errors;
}

/**
 * Trader: every number carried into `trader.json` must equal `trader-math.json` —
 * raw odds, implied, overround, fair probs, the per-outcome value map, the chosen
 * de-vig method, the threshold, and bestSelection.
 */
export function crossCheckTrader(report: unknown, math: TraderMath): string[] {
  const errors: string[] = [];
  if (!isObject(report)) return ["trader: report must be an object"];

  eqTriple(report.rawOdds, math.rawOdds, "rawOdds", errors);
  eqTriple(report.impliedRaw, math.impliedRaw, "impliedRaw", errors);
  eqNum(report.overround, math.overround, "overround", errors);
  eqTriple(report.fairProbs, math.fairProbs, "fairProbs", errors);
  eqNum(report.valueThreshold, math.valueThreshold, "valueThreshold", errors);

  if (report.deVigMethod !== math.deVigMethod) {
    errors.push(`deVigMethod: must equal the deterministic source "${math.deVigMethod}"`);
  }
  if ((report.bestSelection ?? null) !== (math.bestSelection ?? null)) {
    errors.push(
      `bestSelection: must equal the deterministic source ${String(math.bestSelection)}`,
    );
  }

  const value = report.value;
  if (!isObject(value)) {
    errors.push("value: must equal the deterministic source object");
  } else {
    for (const o of OUTCOMES) {
      const entry = value[o];
      const refEntry = math.value[o];
      if (!isObject(entry)) {
        errors.push(`value.${o}: must equal the deterministic source object`);
        continue;
      }
      eqNum(entry.ourProb, refEntry.ourProb, `value.${o}.ourProb`, errors);
      eqNum(entry.fairProb, refEntry.fairProb, `value.${o}.fairProb`, errors);
      eqNum(entry.edge, refEntry.edge, `value.${o}.edge`, errors);
      if (entry.hasValue !== refEntry.hasValue) {
        errors.push(
          `value.${o}.hasValue: must equal the deterministic source ${refEntry.hasValue}`,
        );
      }
    }
  }

  return errors;
}

/**
 * Risk Manager: the bankroll-discipline numbers in `risk.json` must equal
 * `risk-math.json` — bankroll, stakePct, the raw and capped stakes, the cap flag,
 * and overround. The approval/warnings are the agent's judgment and are NOT
 * cross-checked here (that is the agent's actual job).
 */
export function crossCheckRisk(report: unknown, math: RiskMath): string[] {
  const errors: string[] = [];
  if (!isObject(report)) return ["risk-manager: report must be an object"];

  eqNum(report.overround, math.overround, "overround", errors);
  eqNum(report.bankroll, math.bankroll, "bankroll", errors);
  eqNum(report.stakePct, math.stakePct, "stakePct", errors);
  eqNum(report.rawStake, math.rawStake, "rawStake", errors);
  eqNum(report.recommendedStake, math.recommendedStake, "recommendedStake", errors);
  if (report.stakeCapped !== math.stakeCapped) {
    errors.push(`stakeCapped: must equal the deterministic source ${math.stakeCapped}`);
  }

  return errors;
}

/** The deterministic sources a BET decision is checked against. */
export interface HeadCoachSources {
  quantMath: QuantMath;
  traderMath: TraderMath;
  riskMath: { recommendedStake: number; ev: number | null };
  consensusOdds: OutcomeOdds;
}

/**
 * Head Coach: for a BET, the headline numbers must be carried through from the
 * deterministic sources, not re-derived. ourProb ← quant-math probs, fairProb /
 * edge ← trader-math, odds ← prefetch consensus, stake / ev ← risk-math, and the
 * selection must be the trader's bestSelection. NO-BET decisions carry no numbers
 * (the schema layer already forces them null), so there is nothing to cross-check.
 */
export function crossCheckHeadCoach(
  decision: unknown,
  sources: HeadCoachSources,
): string[] {
  const errors: string[] = [];
  if (!isObject(decision)) return ["head-coach: decision must be an object"];
  if (decision.recommendation !== "BET") return errors; // NO-BET → nothing to check

  const sel = decision.selection;
  if (sel !== "home" && sel !== "draw" && sel !== "away") {
    errors.push("selection: must be a valid outcome to cross-check a BET");
    return errors;
  }
  const o = sel as Outcome;

  if ((sources.traderMath.bestSelection ?? null) !== o) {
    errors.push(
      `selection: must equal the trader's bestSelection ${String(sources.traderMath.bestSelection)}`,
    );
  }

  eqNum(decision.ourProb, sources.quantMath.probs[o], "ourProb", errors);
  eqNum(decision.fairProb, sources.traderMath.fairProbs[o], "fairProb", errors);
  eqNum(decision.edge, sources.traderMath.value[o].edge, "edge", errors);
  eqNum(decision.odds, sources.consensusOdds[o], "odds", errors);
  eqNum(decision.stake, sources.riskMath.recommendedStake, "stake", errors);
  if (sources.riskMath.ev !== null) {
    eqNum(decision.ev, sources.riskMath.ev, "ev", errors);
  }

  return errors;
}

// Re-export the contract types touched here for convenience to callers that want
// to build well-typed fixtures before validating them.
export type {
  FormScoutReport,
  QuantReport,
  TraderReport,
  RiskReport,
  SharpReport,
  FinalDecision,
};
