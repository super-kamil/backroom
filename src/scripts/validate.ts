/**
 * validate.ts — CLI gate that an agent's JSON report must clear or be retried.
 *
 *   bun src/scripts/validate.ts <agent> <fixtureId>
 *
 * Maps the agent name to its run artifact, reads that JSON from the run dir, and
 * runs it through TWO layers:
 *   1. validators.validateReport  — schema / bounds / internal consistency.
 *   2. a CROSS-CHECK against the deterministic *-math.json source — the agent's
 *      copied numbers must EQUAL the script-computed ones, not merely be
 *      in-bounds. This is what makes the determinism boundary mechanical rather
 *      than prompt-enforced: a within-bounds altered probability FAILS here.
 *
 * Prints "VALID <agent>" + exit 0 on success; on failure prints one
 * "INVALID <agent>: <error>" line per error + exit 1 so the orchestrating skill
 * detects the failure and sends the agent back to fix it.
 */

import type {
  OutcomeOdds,
  PrefetchBundle,
  QuantMath,
} from "../lib/contracts.ts";
import {
  validateReport,
  crossCheckQuant,
  crossCheckTrader,
  crossCheckRisk,
  crossCheckHeadCoach,
  type TraderMath,
  type RiskMath,
} from "../lib/validators.ts";
import { runPath, type RunArtifact } from "../lib/run-paths.ts";

/** Agent name → the run artifact that holds its report. */
const AGENT_ARTIFACT: Record<string, RunArtifact> = {
  "form-scout": "form-scout",
  quant: "quant",
  trader: "trader",
  "risk-manager": "risk",
  sharp: "sharp",
  "head-coach": "decision",
};

const agent = process.argv[2];
const fixtureId = process.argv[3];

if (!agent || !fixtureId) {
  console.error("usage: bun src/scripts/validate.ts <agent> <fixtureId>");
  process.exit(1);
}

const artifact = AGENT_ARTIFACT[agent];
if (!artifact) {
  console.error(
    `INVALID ${agent}: unknown agent (expected one of ${Object.keys(AGENT_ARTIFACT).join(", ")})`,
  );
  process.exit(1);
}

const path = runPath(fixtureId, artifact);

let data: unknown;
try {
  data = await Bun.file(path).json();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`INVALID ${agent}: could not read ${path}: ${msg}`);
  process.exit(1);
}

/** Read a deterministic run artifact as JSON (throws if absent/malformed). */
async function readArtifact<T>(art: RunArtifact): Promise<T> {
  return (await Bun.file(runPath(fixtureId as string, art)).json()) as T;
}

/**
 * Cross-check the agent's copied numbers against the deterministic *-math.json
 * source. Returns the equality errors (empty when the agent passed the numbers
 * through faithfully). A NO-BET head-coach decision carries no numbers and has no
 * math sources to read, so it short-circuits to no cross-check.
 */
async function runCrossCheck(): Promise<string[]> {
  switch (agent) {
    case "quant": {
      const math = await readArtifact<QuantMath>("quant-math");
      return crossCheckQuant(data, math);
    }
    case "trader": {
      const math = await readArtifact<TraderMath>("trader-math");
      return crossCheckTrader(data, math);
    }
    case "risk-manager": {
      const math = await readArtifact<RiskMath>("risk-math");
      return crossCheckRisk(data, math);
    }
    case "head-coach": {
      if (
        typeof data !== "object" ||
        data === null ||
        (data as { recommendation?: unknown }).recommendation !== "BET"
      ) {
        return []; // NO-BET (or malformed; schema layer reports that) → nothing to cross-check
      }
      const [quantMath, traderMath, riskMath, prefetch] = await Promise.all([
        readArtifact<QuantMath>("quant-math"),
        readArtifact<TraderMath>("trader-math"),
        readArtifact<{ recommendedStake: number; ev: number | null }>(
          "risk-math",
        ),
        readArtifact<PrefetchBundle>("prefetch"),
      ]);
      return crossCheckHeadCoach(data, {
        quantMath,
        traderMath,
        riskMath,
        consensusOdds: prefetch.odds.consensus as OutcomeOdds,
      });
    }
    default:
      return []; // form-scout, sharp: no computed numbers to cross-check
  }
}

const result = validateReport(agent, data);
const errors = [...result.errors];

try {
  errors.push(...(await runCrossCheck()));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  errors.push(
    `could not read a deterministic source file to cross-check: ${msg}`,
  );
}

if (errors.length === 0) {
  console.log(`VALID ${agent}`);
  process.exit(0);
}

for (const error of errors) {
  console.error(`INVALID ${agent}: ${error}`);
}
process.exit(1);
