/**
 * fun-pick.ts — the deterministic "just for fun" pick ranking.
 *
 * NOT BETTING ADVICE. When the real verdict is NO-BET, the orchestrator may
 * surface an entertainment aside: the three 1X2 outcomes ranked by market price
 * into safest / balanced / long-shot. This is a pure ordering of the MARKET's own
 * prices (it never uses our model estimate, so it stays trustworthy even when the
 * model is degenerate) and every pick is negative-EV — you pay the vig. The
 * presenter must label it as entertainment and keep NO-BET as the recommendation.
 *
 * Reads:   trader-math.json (raw consensus odds + vig-free fair probs).
 * Writes:  fun-pick.json (FunPicks).
 *
 *   bun run src/scripts/fun-pick.ts <fixtureId>
 */

import type { ValueView } from "../lib/odds-math.ts";
import { funPicks } from "../lib/odds-math.ts";
import { runPath } from "../lib/run-paths.ts";

const id = process.argv[2];
if (id === undefined || id === "") {
  console.error("usage: bun run src/scripts/fun-pick.ts <fixtureId>");
  process.exit(1);
}

const traderMathPath = runPath(id, "trader-math");
const file = Bun.file(traderMathPath);
if (!(await file.exists())) {
  console.error(
    `missing ${traderMathPath} — run devig.ts before fun-pick.ts (needs market odds).`,
  );
  process.exit(1);
}
const traderMath = (await file.json()) as ValueView;

const picks = funPicks(traderMath.rawOdds, traderMath.fairProbs);

await Bun.write(runPath(id, "fun-pick"), JSON.stringify(picks, null, 2));

const line = (label: string, p: { outcome: string; odds: number; fairProb: number }) =>
  `  ${label}: ${p.outcome} @ ${p.odds} (market ~${(p.fairProb * 100).toFixed(0)}%)`;
console.log("FOR FUN ONLY — not advice, no edge, negative-EV:");
console.log(line("safest  ", picks.safest));
console.log(line("balanced", picks.balanced));
console.log(line("longshot", picks.longshot));
