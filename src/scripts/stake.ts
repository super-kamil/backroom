/**
 * stake.ts — the deterministic stake-sizing math the Risk Manager agent runs.
 *
 * Reads the Trader's deterministic value math (trader-math.json), sizes the
 * stake under fixed-percentage discipline with the MAX_STAKE cap, computes EV on
 * the best selection, and writes risk-math.json. The Risk Manager agent then
 * reads that file and applies its responsible-gambling judgment — it does no
 * arithmetic itself.
 *
 *   bun run src/scripts/stake.ts <fixtureId>
 */

import type { Outcome, OutcomeOdds, TraderReport } from "../lib/contracts.ts";
import { expectedValue, fixedPctStake } from "../lib/odds-math.ts";
import { BANKROLL, MAX_STAKE, STAKE_PCT } from "../lib/config.ts";
import { runPath } from "../lib/run-paths.ts";

type TraderMath = Omit<TraderReport, "agent" | "notes">;

const id = process.argv[2];
if (id === undefined || id === "") {
  console.error("usage: bun run src/scripts/stake.ts <fixtureId>");
  process.exit(1);
}

const trader = (await Bun.file(runPath(id, "trader-math")).json()) as TraderMath;
const { value, rawOdds, overround, bestSelection } = trader;

const rawStake = bestSelection ? fixedPctStake(BANKROLL, STAKE_PCT, MAX_STAKE) : 0;
const recommendedStake = Math.min(rawStake, MAX_STAKE);
const stakeCapped = rawStake !== recommendedStake;

const sel: Outcome | null = bestSelection;
const odds: OutcomeOdds = rawOdds;
const ev =
  sel !== null ? expectedValue(value[sel].ourProb, odds[sel]) : null;

const result = {
  overround,
  bankroll: BANKROLL,
  stakePct: STAKE_PCT,
  rawStake,
  recommendedStake,
  stakeCapped,
  ev,
  bestSelection,
};

await Bun.write(runPath(id, "risk-math"), JSON.stringify(result, null, 2));

console.log(`recommendedStake: ${recommendedStake}`);
console.log(`ev: ${ev ?? "null"}`);
