/**
 * model-plausibility.test.ts — unit tests for the pure reliability check.
 *
 * The headline case is Belgium vs Iran (neutral-venue World Cup): a correct
 * computation over a degenerate input. The other cases pin the healthy path and
 * the guards (divide-by-zero, absent optional fields).
 */

import { test, expect } from "bun:test";
import {
  assessModelPlausibility,
  MIN_PLAUSIBLE_LAMBDA,
  MAX_FAVORITE_DEFLATION,
  MAX_API_DIVERGENCE,
  MAX_DRAW_OVER_MARKET,
} from "./model-plausibility.ts";

test("thresholds hold their specified values", () => {
  expect(MIN_PLAUSIBLE_LAMBDA).toBe(0.4);
  expect(MAX_FAVORITE_DEFLATION).toBe(0.5);
  expect(MAX_API_DIVERGENCE).toBe(0.2);
  expect(MAX_DRAW_OVER_MARKET).toBe(1.5);
});

test("Belgium vs Iran: degenerate input is flagged unreliable with all four flags", () => {
  const result = assessModelPlausibility({
    lambda: { home: 0.9008620689655172, away: 0.14583333333333334 },
    probs: {
      home: 0.5425077466313654,
      draw: 0.3987588038466106,
      away: 0.05873344952202428,
    },
    scoringRates: { home: 3.8, away: 1.875 },
    apiProbs: { home: 0.35, draw: 0.35, away: 0.3 },
    marketFairDraw: 0.20703434164044554,
  });

  expect(result.reliable).toBe(false);

  const codes = result.flags.map((f) => f.code);

  // Degenerate: away λ (0.146) is below the floor; home λ (0.901) is not.
  expect(codes).toContain("degenerate-lambda-away");
  expect(codes).not.toContain("degenerate-lambda-home");

  // Degenerate: home is the favorite (3.8 > 1.875) and 0.901 / 3.8 = 0.237 < 0.5.
  expect(codes).toContain("favorite-deflation");

  // Warn flags both fire.
  expect(codes).toContain("api-divergence");
  expect(codes).toContain("draw-over-market");

  // Severities line up: two degenerate, two warn.
  const degenerate = result.flags.filter((f) => f.severity === "degenerate");
  const warn = result.flags.filter((f) => f.severity === "warn");
  expect(degenerate.map((f) => f.code).sort()).toEqual([
    "degenerate-lambda-away",
    "favorite-deflation",
  ]);
  expect(warn.map((f) => f.code).sort()).toEqual([
    "api-divergence",
    "draw-over-market",
  ]);
});

test("healthy fixture: reliable with no flags", () => {
  const result = assessModelPlausibility({
    lambda: { home: 1.6, away: 1.1 },
    probs: { home: 0.46, draw: 0.27, away: 0.27 },
    scoringRates: { home: 1.7, away: 1.2 },
    apiProbs: { home: 0.45, draw: 0.28, away: 0.27 },
    marketFairDraw: 0.26,
  });

  expect(result.reliable).toBe(true);
  expect(result.flags).toEqual([]);
});

test("zero scoring rate does not throw (divide-by-zero guarded)", () => {
  // Away has the higher raw rate here, but its rate is 0 → deflation check skips
  // it rather than dividing by zero. λ are healthy so no degenerate-λ either.
  expect(() =>
    assessModelPlausibility({
      lambda: { home: 1.2, away: 0.9 },
      probs: { home: 0.42, draw: 0.3, away: 0.28 },
      scoringRates: { home: 0, away: 0 },
    }),
  ).not.toThrow();

  const result = assessModelPlausibility({
    lambda: { home: 1.2, away: 0.9 },
    probs: { home: 0.42, draw: 0.3, away: 0.28 },
    scoringRates: { home: 0, away: 0 },
  });
  expect(result.reliable).toBe(true);
  expect(result.flags.map((f) => f.code)).not.toContain("favorite-deflation");
});

test("absent optional fields skip the cross-check / market checks without throwing", () => {
  const result = assessModelPlausibility({
    lambda: { home: 1.5, away: 1.0 },
    probs: { home: 0.5, draw: 0.4, away: 0.1 },
    scoringRates: { home: 1.6, away: 1.1 },
    // apiProbs and marketFairDraw omitted entirely.
  });

  expect(result.reliable).toBe(true);
  const codes = result.flags.map((f) => f.code);
  expect(codes).not.toContain("api-divergence");
  expect(codes).not.toContain("draw-over-market");
});

test("null optional fields are treated as absent", () => {
  const result = assessModelPlausibility({
    lambda: { home: 1.5, away: 1.0 },
    probs: { home: 0.5, draw: 0.4, away: 0.1 },
    scoringRates: { home: 1.6, away: 1.1 },
    apiProbs: null,
    marketFairDraw: null,
  });
  expect(result.reliable).toBe(true);
  expect(result.flags).toEqual([]);
});

test("api-divergence alone is a warn and stays reliable", () => {
  const result = assessModelPlausibility({
    lambda: { home: 1.5, away: 1.2 },
    probs: { home: 0.6, draw: 0.25, away: 0.15 },
    scoringRates: { home: 1.6, away: 1.3 },
    apiProbs: { home: 0.3, draw: 0.3, away: 0.4 }, // 0.30 gap on home/away
  });
  expect(result.reliable).toBe(true);
  expect(result.flags.map((f) => f.code)).toEqual(["api-divergence"]);
});

test("draw-over-market alone is a warn and stays reliable", () => {
  const result = assessModelPlausibility({
    lambda: { home: 1.3, away: 1.3 },
    probs: { home: 0.3, draw: 0.4, away: 0.3 },
    scoringRates: { home: 1.4, away: 1.4 },
    marketFairDraw: 0.24, // 0.40 > 1.5 × 0.24 = 0.36
  });
  expect(result.reliable).toBe(true);
  expect(result.flags.map((f) => f.code)).toEqual(["draw-over-market"]);
});
