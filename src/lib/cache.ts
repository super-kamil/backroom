/**
 * cache.ts — a tiny bun:sqlite TTL cache. The data layer caches STABLE inputs
 * (season stats, standings, coverage, historical fixtures) with explicit TTLs.
 *
 * Live data such as current odds is volatile and MUST be fetched fresh — bypass
 * the cache for it, per the data policy.
 *
 * Expiry is driven by an injectable clock (`now`) so TTL behaviour is unit-testable.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** TTL for stable data: season stats, standings, coverage, historical fixtures. */
export const STABLE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheRow {
  value: string;
  expiresAt: number;
}

export class Cache {
  private readonly db: Database;
  private readonly now: () => number;

  constructor(dbPath: string, now: () => number = Date.now) {
    this.now = now;
    // bun:sqlite will not create the parent directory; ensure it exists first
    // (skip the in-memory sentinel used by tests).
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(
      "CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, expiresAt INTEGER NOT NULL)",
    );
  }

  /** Fresh JSON-parsed value, or null if absent/expired. Expired rows are evicted. */
  get<T>(key: string): T | null {
    const row = this.db
      .query<CacheRow, [string]>("SELECT value, expiresAt FROM cache WHERE key = ?")
      .get(key);
    if (row === null) return null;
    if (row.expiresAt <= this.now()) {
      this.db.run("DELETE FROM cache WHERE key = ?", [key]);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  /** Store value as JSON with expiry = now + ttlMs (upsert). */
  set<T>(key: string, value: T, ttlMs: number): void {
    const expiresAt = this.now() + ttlMs;
    this.db.run(
      "INSERT INTO cache(key, value, expiresAt) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiresAt = excluded.expiresAt",
      [key, JSON.stringify(value), expiresAt],
    );
  }

  /** Serve a fresh cached value, else fetch once, cache it, and return it. */
  async withCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await fetcher();
    this.set(key, fresh, ttlMs);
    return fresh;
  }

  close(): void {
    this.db.close();
  }
}
