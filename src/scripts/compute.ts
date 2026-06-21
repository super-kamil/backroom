/**
 * compute.ts — the deterministic Poisson math the Quant agent runs.
 *
 * Reads the prefetch bundle's season-long baseline, runs computeOneXTwo, and
 * writes the QuantMath result to quant-math.json. The Quant agent then reads
 * that file and sanity-checks it — it does no arithmetic itself.
 *
 *   bun run src/scripts/compute.ts <fixtureId>
 */

import type { PrefetchBundle } from "../lib/contracts.ts";
import { computeOneXTwo } from "../lib/odds-math.ts";
import { runPath } from "../lib/run-paths.ts";

const id = process.argv[2];
if (id === undefined || id === "") {
  console.error("usage: bun run src/scripts/compute.ts <fixtureId>");
  process.exit(1);
}

const bundle = (await Bun.file(
  runPath(id, "prefetch"),
).json()) as PrefetchBundle;
const math = computeOneXTwo(bundle.baseline);

await Bun.write(runPath(id, "quant-math"), JSON.stringify(math, null, 2));

console.log(`lambda: home=${math.lambda.home} away=${math.lambda.away}`);
console.log(
  `1X2 probs: home=${math.probs.home} draw=${math.probs.draw} away=${math.probs.away}`,
);
