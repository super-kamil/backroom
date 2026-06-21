/**
 * contracts.ts — the authoritative JSON contracts for the thin chain (MVP).
 *
 * Every agent communicates via these structured shapes, never free-form text.
 * Every deterministic script reads/writes these shapes. The orchestrator's job
 * is integration + verification, which is only reliable with structured data.
 *
 * MVP MARKET: 1X2 (match result) ONLY.
 * Over/Under, BTTS, player props, and parlays are named extension points and
 * MUST NOT appear in these contracts yet.
 *
 * Flow:  prefetch (deterministic) → Form Scout → Quant → Trader → Risk Manager
 *        → Sharp → Head Coach final decision → calibration log.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** The three 1X2 outcomes, from the home team's perspective. */
export type Outcome = "home" | "draw" | "away";

/** A probability triple over the 1X2 outcomes. Should sum to ~1 when fair. */
export interface OutcomeProbs {
  home: number;
  draw: number;
  away: number;
}

/** Decimal odds (e.g. 2.50) for each outcome. */
export type OutcomeOdds = OutcomeProbs;

export interface TeamRef {
  id: number;
  name: string;
}

export interface FixtureRef {
  id: number;
  league: { id: number; name: string; season: number };
  date: string; // ISO 8601
  venue: string | null;
  status: string; // e.g. "NS" (not started), "FT" (finished)
  home: TeamRef;
  away: TeamRef;
}

/**
 * API-Football per-league coverage flags. The data layer reads these BEFORE
 * calling any downstream endpoint and degrades gracefully when false.
 */
export interface Coverage {
  fixtures: boolean;
  statistics: boolean;
  standings: boolean;
  odds: boolean;
  predictions: boolean;
  // Out of MVP scope but tracked so the gate can report them:
  lineups: boolean;
  injuries: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic prefetch → the context handed to agents
// ─────────────────────────────────────────────────────────────────────────────

/** One recent match, normalized, for the Form Scout's SHORT window. */
export interface MatchSummary {
  fixtureId: number;
  date: string;
  opponent: TeamRef;
  home: boolean; // was the subject team at home?
  goalsFor: number;
  goalsAgainst: number;
  result: "W" | "D" | "L";
  /** Optional — API-Football exposes xG only for some competitions. */
  xgFor?: number;
  xgAgainst?: number;
}

/** SHORT-window momentum slice (last N matches). Form Scout input only. */
export interface FormWindow {
  windowSize: number; // N matches actually returned
  matches: MatchSummary[]; // most-recent first
}

/**
 * SEASON-LONG baseline rates for the Quant's Poisson model. This is a SEPARATE
 * input from the form window, with a SEPARATE time horizon. Never conflate them.
 * Rates are goals-for / goals-against per match, split home/away, plus the
 * league averages used to normalize into attack/defense strengths.
 */
export interface BaselineRates {
  league: {
    /** League-wide average goals scored by home teams per match. */
    avgHomeGoals: number;
    /** League-wide average goals scored by away teams per match. */
    avgAwayGoals: number;
  };
  home: {
    matchesPlayed: number;
    /** Goals scored per home match. */
    goalsForPerHome: number;
    /** Goals conceded per home match. */
    goalsAgainstPerHome: number;
  };
  away: {
    matchesPlayed: number;
    /** Goals scored per away match. */
    goalsForPerAway: number;
    /** Goals conceded per away match. */
    goalsAgainstPerAway: number;
  };
}

export interface BookmakerOdds {
  bookmaker: string;
  odds: OutcomeOdds; // decimal
}

export interface OddsData {
  /** Per-bookmaker decimal odds. */
  bookmakers: BookmakerOdds[];
  /** Consensus (median) decimal odds across bookmakers. */
  consensus: OutcomeOdds;
}

/**
 * The full deterministic prefetch package. Produced entirely by scripts before
 * any LLM runs; each agent is then handed only its focused slice.
 */
export interface PrefetchBundle {
  fixture: FixtureRef;
  coverage: Coverage;
  /** Short-window form, one per team. Form Scout input. */
  form: { home: FormWindow; away: FormWindow };
  /** Season-long baseline. Quant input. */
  baseline: {
    home: BaselineRates["home"];
    away: BaselineRates["away"];
    league: BaselineRates["league"];
  };
  /** Live market odds. Trader input. */
  odds: OddsData;
  /** API-Football's OWN model — cross-check reference only, never our estimate. */
  apiPredictions?: OutcomeProbs;
  /**
   * How the `baseline` rates were derived, so the Data Quality Gate can tell a
   * real season aggregate apart from the LIVE recent-form proxy:
   *   - "season"        — a season-to-date `/teams/statistics` aggregate (live)
   *                       or an as-of-kickoff fixtures reconstruction (validation).
   *   - "form-fallback" — the neutral-venue / data-thin LIVE fallback
   *                       (`computeBaselineFromForm`) fired: rates come from each
   *                       team's recent-form window, NOT opposition-adjusted and
   *                       materially less calibrated. The gate caps confidence to
   *                       at most "medium" when this is set.
   * OPTIONAL: `undefined` means a normal season aggregate (the common case), so
   * existing PrefetchBundle constructors and test fixtures compile unchanged.
   */
  baselineSource?: "season" | "form-fallback";
  /** ISO timestamps per data source, and confirmed-vs-probable flags. */
  dataTimestamps: Record<string, string>;
  /** Inputs that could not be fetched (drives the Data Quality Gate). */
  missing: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Quality Gate (runs before any recommendation)
// ─────────────────────────────────────────────────────────────────────────────

export interface DataQualityResult {
  gate: "pass" | "fail";
  checks: {
    oddsAvailable: boolean;
    sufficientHomeForm: boolean;
    sufficientAwayForm: boolean;
    baselineAvailable: boolean;
    coverageChecked: boolean;
  };
  missing: string[];
  /** Overall confidence in the inputs feeding the pipeline. */
  inputConfidence: "high" | "medium" | "low";
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent reports (the structured contracts between agents)
// ─────────────────────────────────────────────────────────────────────────────

export type Trend = "improving" | "declining" | "stable";

export interface TeamFormView {
  trend: Trend;
  /** 0..1 — quality of recent form, accounting for opposition strength. */
  formQuality: number;
  /** How strong were the opponents faced? Plain-language. */
  qualityOfOpposition: string;
  notableSignals: string[];
  summary: string;
}

/** Form Scout: recent form / momentum, interpreted qualitatively. */
export interface FormScoutReport {
  agent: "form-scout";
  home: TeamFormView;
  away: TeamFormView;
  /** 0..1 confidence in this read given sample size & data quality. */
  confidence: number;
  notes: string;
}

/**
 * Deterministic Poisson output (written by src/scripts/compute.ts). The Quant
 * AGENT does not compute these; it runs the script and sanity-checks the result.
 */
export interface QuantMath {
  /** Expected goals (Poisson λ) per side. */
  lambda: { home: number; away: number };
  /** Collapsed 1X2 probabilities (sum ~1). */
  probs: OutcomeProbs;
  /** Most-likely exact scorelines, descending by probability. */
  scorelineTopN: Array<{ home: number; away: number; prob: number }>;
  mathVersion: string;
}

/** Quant: independent probability estimate + sanity interpretation. */
export interface QuantReport {
  agent: "quant";
  math: QuantMath;
  crossCheck: {
    source: "api-football-predictions";
    probs?: OutcomeProbs;
    /** Plain-language agreement assessment vs our independent estimate. */
    agreement: "aligned" | "diverges" | "unavailable";
  };
  sanityChecks: {
    sumsToOne: boolean;
    lambdaInRange: boolean;
    notes: string;
  };
  /** 0..1 confidence in the estimate. */
  confidence: number;
  notes: string;
}

/** Trader: de-vig the market and locate value vs the Quant's estimate. */
export interface TraderReport {
  agent: "trader";
  rawOdds: OutcomeOdds;
  /** Raw implied probs (1/odds) — sums to >1 by the overround. */
  impliedRaw: OutcomeProbs;
  /** Bookmaker margin: (sum of impliedRaw) − 1. */
  overround: number;
  deVigMethod: "proportional" | "power" | "shin";
  /** Vig-free fair probabilities (sum ~1). */
  fairProbs: OutcomeProbs;
  /** Per-outcome value, edge = ourProb − fairProb. */
  value: Record<
    Outcome,
    { ourProb: number; fairProb: number; edge: number; hasValue: boolean }
  >;
  /**
   * The DETERMINISTIC "highest-qualifying-edge outcome" computed by
   * `computeValue` (odds-math.ts) — the single outcome whose edge clears
   * `valueThreshold` by the widest margin, or null when none qualifies. This is
   * NOT a recommendation: it is a fixed arithmetic result. Agents (and the Head
   * Coach) MUST copy it through verbatim — the backpressure validator enforces
   * equality, so re-deriving or "improving" it is a validation failure.
   */
  bestSelection: Outcome | null;
  valueThreshold: number;
  notes: string;
}

/** Risk Manager: bankroll discipline + responsible-gambling gate. */
export interface RiskReport {
  agent: "risk-manager";
  overround: number;
  bankroll: number;
  stakePct: number;
  /** Stake before any cap. */
  rawStake: number;
  /** Stake after MAX_STAKE / bankroll caps applied. */
  recommendedStake: number;
  stakeCapped: boolean;
  responsibleGambling: { pass: boolean; warnings: string[] };
  approval: "approved" | "reduced" | "rejected";
  notes: string;
}

/**
 * Sharp (Critic / Red-Team). Runs in FRESH context: sees only the raw data and
 * the proposed conclusion, NOT the Quant's reasoning. Its job is to attack.
 */
export interface SharpChallenge {
  type:
    | "recency-bias"
    | "small-sample"
    | "overrated-favorite"
    | "stale-data"
    | "market-smarter"
    | "draw-underweight"
    | "other";
  severity: "low" | "medium" | "high";
  argument: string;
}

export interface SharpReport {
  agent: "sharp";
  verdict: "agree" | "disagree" | "uncertain";
  challenges: SharpChallenge[];
  recommendation: "proceed" | "reduce-confidence" | "no-bet";
  notes: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Final decision + calibration record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Version stamp persisted with EVERY prediction so calibration changes can be
 * attributed to a specific cause (prompt edit, model swap, threshold change…).
 */
export interface PipelineVersion {
  pipelineVersion: string;
  agentPromptVersions: Record<string, string>;
  modelAssignments: Record<string, "high_reasoning" | "standard_reasoning">;
  mathVersion: string;
  dataProvider: string;
  deVigMethod: "proportional" | "power" | "shin";
  valueThreshold: number;
  createdAt: string; // ISO
  dataTimestamps: Record<string, string>;
}

/** The Head Coach's final, human-facing decision. "NO-BET" is first-class. */
export interface FinalDecision {
  matchId: number;
  fixture: FixtureRef;
  recommendation: "BET" | "NO-BET";
  selection: Outcome | null;
  ourProb: number | null;
  fairProb: number | null;
  edge: number | null;
  odds: number | null;
  ev: number | null; // expected value per unit stake
  stake: number | null;
  confidence: "high" | "medium" | "low";
  rationale: string;
  dissent: { sharpVerdict: SharpReport["verdict"]; divergence: string };
  dataQuality: DataQualityResult;
  version: PipelineVersion;
}

/** One row in the calibration / backtest log (bun:sqlite). */
export interface PredictionRecord {
  matchId: number;
  league: string;
  kickoff: string;
  decision: FinalDecision;
  /** Filled in by `settle` after the match resolves. */
  actualOutcome: Outcome | null;
  /** Brier contribution for the predicted probability vs actual (filled at settle). */
  brier: number | null;
  settledAt: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation mode — calibration predictions (odds-free core + optional value P&L)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The de-vig + value view attached to a backtest row when historical odds are
 * available (Pro plan). It is exactly the deterministic Trader math shape, so the
 * backtest and the live chain measure value identically. OPTIONAL: a pure
 * probability-calibration row (no odds) simply omits it.
 */
export type CalibrationMarket = Omit<TraderReport, "agent" | "notes">;

/**
 * A validation-mode calibration prediction: our independent FULL 1X2 estimate for
 * a (historical) match, paired with the actual outcome — the honest answer to
 * "do our 70% calls land at 70%?". The probability calibration is the odds-free,
 * honest core. When historical odds are available (Pro plan) an OPTIONAL `market`
 * block additionally carries the de-vig + value view, so the backtest can report a
 * flat-stake value P&L alongside calibration. It is stored in its OWN table,
 * separate from the betting `PredictionRecord`, so the live betting chain and gate
 * stay untouched.
 *
 * For a historical backtest the outcome is already known, so `actualOutcome` and
 * `brier` (multiclass) are populated immediately ("settled at creation").
 */
export interface CalibrationPrediction {
  matchId: number;
  league: string;
  kickoff: string;
  /** Our independent 1X2 estimate (full triple, sums to ~1). */
  probs: OutcomeProbs;
  /** Poisson expected goals behind the estimate. */
  lambda: { home: number; away: number };
  /** Known immediately for a historical backtest; null until settled otherwise. */
  actualOutcome: Outcome | null;
  /** Multiclass Brier vs the actual outcome (filled when settled). */
  brier: number | null;
  /** Optional de-vig + value view (present when historical odds were fetched). */
  market?: CalibrationMarket;
  mode: "validation";
  version: PipelineVersion;
  createdAt: string;
  settledAt: string | null;
}

/**
 * A neutral, normalized finished-match result (home/away perspective, not subject-
 * team). The historical backtest derives every as-of-date baseline from a list of
 * these — computing team strength from only matches BEFORE each fixture, so there
 * is no lookahead bias.
 */
export interface MatchResult {
  fixtureId: number;
  date: string;
  home: TeamRef;
  away: TeamRef;
  goalsHome: number;
  goalsAway: number;
  outcome: Outcome; // derived from goals
  status: string; // e.g. "FT"
}
