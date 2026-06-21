/**
 * plausibility.ts — the deterministic model-plausibility pre-check.
 *
 * Runs AFTER compute.ts (quant-math.json) and devig.ts (trader-math.json) but
 * BEFORE any LLM agent, so a structurally un-priceable fixture fails CHEAPLY
 * rather than burning the whole subagent chain to rediscover it. It does NOT
 * change the math — it reads the deterministic outputs and flags when the
 * estimate is unreliable (degenerate λ, a favorite deflated far below its
 * scoring rate, a large divergence from the API model, or a draw far above the
 * market's vig-free fair price).
 *
 * Reads:   prefetch.json (baseline scoring rates + apiPredictions),
 *          quant-math.json (λ + 1X2 probs), trader-math.json (fair draw).
 * Writes:  plausibility.json (PlausibilityResult).
 * Exit:    0 when reliable, 2 when a degenerate flag fired (NO-BET short-circuit),
 *          1 on a usage / missing-input error. The verdict in plausibility.json
 *          is authoritative; the exit code is a convenience for the orchestrator.
 *
 *   bun run src/scripts/plausibility.ts <fixtureId>
 */

import type { PrefetchBundle, QuantMath } from "../lib/contracts.ts";
import type { ValueView } from "../lib/odds-math.ts";
import { assessModelPlausibility } from "../lib/model-plausibility.ts";
import { runPath } from "../lib/run-paths.ts";

const id = process.argv[2];
if (id === undefined || id === "") {
  console.error("usage: bun run src/scripts/plausibility.ts <fixtureId>");
  process.exit(1);
}

async function readJson<T>(artifact: Parameters<typeof runPath>[1]): Promise<T> {
  const path = runPath(id as string, artifact);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(
      `missing ${path} — run prefetch.ts, compute.ts and devig.ts before plausibility.ts.`,
    );
    process.exit(1);
  }
  return (await file.json()) as T;
}

const bundle = await readJson<PrefetchBundle>("prefetch");
const quantMath = await readJson<QuantMath>("quant-math");
const traderMath = await readJson<ValueView>("trader-math");

const result = assessModelPlausibility({
  lambda: quantMath.lambda,
  probs: quantMath.probs,
  scoringRates: {
    home: bundle.baseline.home.goalsForPerHome,
    away: bundle.baseline.away.goalsForPerAway,
  },
  apiProbs: bundle.apiPredictions ?? null,
  marketFairDraw: traderMath.fairProbs.draw,
});

await Bun.write(
  runPath(id, "plausibility"),
  JSON.stringify(result, null, 2),
);

console.log(`reliable: ${result.reliable}`);
for (const f of result.flags) {
  console.log(`  [${f.severity}] ${f.code}: ${f.detail}`);
}

process.exit(result.reliable ? 0 : 2);
