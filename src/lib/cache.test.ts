import { expect, test } from "bun:test";
import { Cache, STABLE_TTL_MS } from "./cache.ts";

/** A mutable clock: a closure over `t` so tests can advance time deterministically. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("set then get returns the stored value", () => {
  const clock = fakeClock();
  const cache = new Cache(":memory:", clock.now);
  cache.set("k", { a: 1, b: "two" }, STABLE_TTL_MS);
  expect(cache.get<{ a: number; b: string }>("k")).toEqual({ a: 1, b: "two" });
  cache.close();
});

test("get returns null for an absent key", () => {
  const cache = new Cache(":memory:", fakeClock().now);
  expect(cache.get("missing")).toBeNull();
  cache.close();
});

test("get returns null once the clock advances past the TTL", () => {
  const clock = fakeClock();
  const cache = new Cache(":memory:", clock.now);
  cache.set("k", 42, 1000);
  clock.advance(999);
  expect(cache.get<number>("k")).toBe(42); // still fresh
  clock.advance(1); // now exactly at expiresAt → expired
  expect(cache.get<number>("k")).toBeNull();
  cache.close();
});

test("set upserts: a second set overwrites the value and extends the TTL", () => {
  const clock = fakeClock();
  const cache = new Cache(":memory:", clock.now);
  cache.set("k", "first", 1000);
  cache.set("k", "second", 5000);
  expect(cache.get<string>("k")).toBe("second");
  clock.advance(1001); // past the old TTL but inside the new one
  expect(cache.get<string>("k")).toBe("second");
  cache.close();
});

test("withCache calls the fetcher exactly once, then serves the cached value", async () => {
  const clock = fakeClock();
  const cache = new Cache(":memory:", clock.now);
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { hits: calls };
  };

  const first = await cache.withCache("k", STABLE_TTL_MS, fetcher);
  const second = await cache.withCache("k", STABLE_TTL_MS, fetcher);

  expect(first).toEqual({ hits: 1 });
  expect(second).toEqual({ hits: 1 }); // served from cache, not re-fetched
  expect(calls).toBe(1);
  cache.close();
});

test("withCache re-fetches after the cached entry expires", async () => {
  const clock = fakeClock();
  const cache = new Cache(":memory:", clock.now);
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls;
  };

  expect(await cache.withCache("k", 1000, fetcher)).toBe(1);
  clock.advance(1000); // expired
  expect(await cache.withCache("k", 1000, fetcher)).toBe(2);
  expect(calls).toBe(2);
  cache.close();
});

test("STABLE_TTL_MS is 24 hours", () => {
  expect(STABLE_TTL_MS).toBe(24 * 60 * 60 * 1000);
});
