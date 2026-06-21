/**
 * config.ts — single source of truth for tunables, model tiers, and the
 * version stamp written with every prediction.
 *
 * Models are referenced BY ROLE (high_reasoning / standard_reasoning), never by
 * hard-coded name in the architecture. Concrete model names live here and can be
 * bumped as new versions ship without touching agents, skills, or scripts.
 */

import type { PipelineVersion } from "./contracts.ts";

// ── Model tiers ──────────────────────────────────────────────────────────────
// No Haiku anywhere. Sonnet is the floor; Opus carries the two highest-value
// reasoning seats (Head Coach final decision + Sharp critic).
export type ModelTier = "high_reasoning" | "standard_reasoning";

export const MODEL_TIERS: Record<ModelTier, string> = {
  high_reasoning: "claude-opus-4-8",
  standard_reasoning: "claude-sonnet-4-6",
};

/** Which tier each agent runs on. The two Opus seats are head-coach + sharp. */
export const AGENT_MODELS: Record<string, ModelTier> = {
  "head-coach": "high_reasoning",
  "form-scout": "standard_reasoning",
  quant: "standard_reasoning",
  trader: "standard_reasoning",
  "risk-manager": "standard_reasoning",
  sharp: "high_reasoning",
};

// ── Tunables (env-overridable) ───────────────────────────────────────────────
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const BANKROLL = num("BANKROLL", 1000);
export const STAKE_PCT = num("STAKE_PCT", 0.02);
export const MAX_STAKE = num("MAX_STAKE", 50);
export const VALUE_THRESHOLD = num("VALUE_THRESHOLD", 0.05);

export type DeVigMethod = "proportional" | "power" | "shin";
export const DEVIG_METHOD: DeVigMethod =
  (process.env.DEVIG_METHOD as DeVigMethod) || "proportional";

// ── Mode + competition selection ─────────────────────────────────────────────
// validation = COMPLETED historical season, reconstructed AS-OF each kickoff (no
//              lookahead). The odds-free probability calibration is the honest
//              core; when historical odds are available (Pro plan) the backtest
//              also reports a value P&L. Drives backtest.ts + MODE-aware prefetch.
// live       = current season with fresh odds (full value chain; needs a plan that
//              unlocks the current season + the odds window — typically paid).
export type Mode = "validation" | "live";
export const MODE: Mode = (process.env.MODE as Mode) || "validation";

// Which competition + season the data layer reads. In validation mode this MUST
// point at a COMPLETED season your plan unlocks (e.g. EPL 2023 = the 2023/24
// season). The capability check (src/scripts/capability.ts) confirms access.
export const LEAGUE_ID = num("LEAGUE_ID", 39); // 39 = Premier League
export const SEASON = num("SEASON", 2023); // 2023 = 2023/24, fully completed
export const FORM_WINDOW = num("FORM_WINDOW", 10); // recent matches, sliced client-side

// ── Data provider ────────────────────────────────────────────────────────────
export const API_BASE_URL =
  process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";
export const API_KEY = process.env.API_FOOTBALL_KEY || "";
export const DATA_PROVIDER = "api-football-v3";

// ── Versioning ───────────────────────────────────────────────────────────────
// Bump these deliberately. Calibration attribution depends on them.
export const PIPELINE_VERSION = "mvp-thin-chain-0.1.0";
export const MATH_VERSION = "poisson-1x2-0.1.0";

/** Prompt versions per agent — bump when an agent's prompt changes. */
export const AGENT_PROMPT_VERSIONS: Record<string, string> = {
  "head-coach": "0.1.0",
  "form-scout": "0.1.0",
  quant: "0.1.0",
  trader: "0.1.0",
  "risk-manager": "0.1.0",
  sharp: "0.1.0",
};

/**
 * Build the version stamp persisted with a prediction. `createdAt` and
 * `dataTimestamps` are passed in (kept out of config so it stays pure/testable).
 */
export function buildVersionStamp(args: {
  createdAt: string;
  dataTimestamps: Record<string, string>;
}): PipelineVersion {
  return {
    pipelineVersion: PIPELINE_VERSION,
    agentPromptVersions: { ...AGENT_PROMPT_VERSIONS },
    modelAssignments: { ...AGENT_MODELS },
    mathVersion: MATH_VERSION,
    dataProvider: DATA_PROVIDER,
    deVigMethod: DEVIG_METHOD,
    valueThreshold: VALUE_THRESHOLD,
    createdAt: args.createdAt,
    dataTimestamps: args.dataTimestamps,
  };
}
