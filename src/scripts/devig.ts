/**
 * devig.ts — the deterministic de-vig + value math the Trader agent runs.
 *
 * Reads the consensus market odds from the prefetch bundle and OUR probabilities
 * from the DETERMINISTIC quant-math.json (compute.ts output), then runs the
 * shared `computeValue` rule (the single implementation used by both the live
 * chain and the historical backtest) and writes trader-math.json. The Trader
 * agent then reads that file and adds qualitative judgment — it does no
 * arithmetic itself.
 *
 * DETERMINISM BOUNDARY: our probabilities are sourced from quant-math.json, NOT
 * from the LLM-written quant.json. A computed number must never round-trip
 * through an agent before a downstream script consumes it — that is exactly the
 * re-transcription hole the boundary exists to close. The validator separately
 * asserts quant.json.math equals quant-math.json (see validators.crossCheckQuant).
 *
 *   bun run src/scripts/devig.ts <fixtureId>
 */

import type { PrefetchBundle, QuantMath } from "../lib/contracts.ts";
import { computeValue } from "../lib/odds-math.ts";
import { DEVIG_METHOD, VALUE_THRESHOLD } from "../lib/config.ts";
import { runPath } from "../lib/run-paths.ts";

const id = process.argv[2];
if (id === undefined || id === "") {
  console.error("usage: bun run src/scripts/devig.ts <fixtureId>");
  process.exit(1);
}

const bundle = (await Bun.file(runPath(id, "prefetch")).json()) as PrefetchBundle;
const quantMath = (await Bun.file(runPath(id, "quant-math")).json()) as QuantMath;

const result = computeValue(
  quantMath.probs,
  bundle.odds.consensus,
  DEVIG_METHOD,
  VALUE_THRESHOLD,
);

await Bun.write(runPath(id, "trader-math"), JSON.stringify(result, null, 2));

console.log(`overround: ${result.overround}`);
console.log(
  `fairProbs: home=${result.fairProbs.home} draw=${result.fairProbs.draw} away=${result.fairProbs.away}`,
);
console.log(`bestSelection: ${result.bestSelection ?? "null"}`);
