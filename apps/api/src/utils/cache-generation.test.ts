import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@scalius/database/client";
import {
  bumpCacheGeneration,
  hasBuyerAvailabilityBandTransition,
  mirrorCacheGeneration,
  readCacheGeneration,
  syncCacheGenerationMirror,
} from "./cache-generation";

const KV_KEY = "cache:generation";

/** A D1 binding over in-memory SQLite with the `cache_generation` table. */
function createD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE cache_generation (
      id TEXT PRIMARY KEY NOT NULL DEFAULT 'default' CHECK (id = 'default'),
      generation TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const statement = (query: string, values: SQLInputValue[] = []) => {
    const execute = () => ({
      results: sqlite.prepare(query).all(...values) as Record<string, SQLOutputValue>[],
      success: true,
      meta: {},
    });
    return {
      bind: (...next: SQLInputValue[]) => statement(query, next),
      run: async () => execute(),
      all: async () => execute(),
      raw: async () => {
        const prepared = sqlite.prepare(query);
        prepared.setReturnArrays(true);
        return prepared.all(...values);
      },
      first: async () => execute().results[0] ?? null,
    };
  };
  const binding = { prepare: (query: string) => statement(query) } as unknown as D1Database;
  const stored = () =>
    (sqlite.prepare("SELECT generation FROM cache_generation").get() as { generation?: string } | undefined)
      ?.generation ?? null;
  return { binding, stored };
}

function createKv(options: { rejectPuts?: number } = {}) {
  const values = new Map<string, string>();
  let rejectPuts = options.rejectPuts ?? 0;
  const kv = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      if (rejectPuts > 0) {
        rejectPuts -= 1;
        throw new Error("KV PUT failed: 429 Too Many Requests");
      }
      values.set(key, value);
    }),
  };
  return { kv, values };
}

function createEnv(options: { rejectPuts?: number } = {}) {
  const d1 = createD1();
  const { kv, values } = createKv(options);
  const env = { DB: d1.binding, CACHE: kv } as unknown as Env;
  return { env, kv, values, stored: d1.stored };
}

// The mirror waits 1.1 s between passes (KV's per-key write limit).
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

/** A committed write followed by its background mirror. */
async function bump(env: Env): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await bumpCacheGeneration({ env, executionCtx: { waitUntil: (p) => pending.push(p) } });
  await settle(Promise.all(pending));
}

describe("store cache generation", () => {
  it("replaces the generation on a write and mirrors it to KV", async () => {
    const { env, values, stored } = createEnv();
    expect(await readCacheGeneration(env)).toBe("0");

    await bump(env);
    const first = stored();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(values.get(KV_KEY)).toBe(first);

    await bump(env);
    expect(stored()).not.toBe(first);
    expect(values.get(KV_KEY)).toBe(stored());
    expect(await readCacheGeneration(env)).toBe(stored());
  });

  it("mirrors after the response through waitUntil", async () => {
    const { env, values, stored } = createEnv();
    const pending: Promise<unknown>[] = [];

    await bumpCacheGeneration({ env, executionCtx: { waitUntil: (p) => pending.push(p) } });
    expect(stored()).not.toBeNull();
    expect(pending).toHaveLength(1);

    await settle(Promise.all(pending));
    expect(values.get(KV_KEY)).toBe(stored());
  });

  it("retries a mirror write rejected by KV's one-write-per-second limit", async () => {
    const { env, kv, values, stored } = createEnv({ rejectPuts: 1 });

    await bump(env);

    expect(kv.put).toHaveBeenCalledTimes(2);
    expect(values.get(KV_KEY)).toBe(stored());
  });

  it("coalesces concurrent writes: the mirror ends on the latest database generation", async () => {
    const { env, kv, values, stored } = createEnv();
    await bump(env);
    const db = getDb(env);
    // A second writer commits between this mirror's put and its next pass.
    kv.put.mockImplementationOnce(async (key: string, value: string) => {
      values.set(key, value);
      await bumpCacheGeneration({ env: { ...env, CACHE: { put: async () => {} } } as unknown as Env });
    });

    await settle(mirrorCacheGeneration(env, db));

    expect(values.get(KV_KEY)).toBe(stored());
  });

  it("falls back to the database on a KV miss and re-mirrors in the background", async () => {
    const { env, values, stored } = createEnv();
    await bump(env);
    values.clear();
    const pending: Promise<unknown>[] = [];

    expect(await readCacheGeneration(env, { waitUntil: (p) => pending.push(p) })).toBe(stored());
    await settle(Promise.all(pending));
    expect(values.get(KV_KEY)).toBe(stored());
  });

  it("serves uncached when neither KV nor the database can provide a generation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failingKv = { get: async () => { throw new Error("kv down"); } };
    expect(await readCacheGeneration({ CACHE: failingKv } as unknown as Env)).toBeNull();
  });

  it("never throws from a write path when the database is unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as Env;

    await expect(bumpCacheGeneration({ env })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("repairs a drifted KV mirror from the scheduled sync and leaves a matching one alone", async () => {
    const { env, kv, values, stored } = createEnv();
    await bump(env);
    values.set(KV_KEY, "stale");
    kv.put.mockClear();

    expect(await syncCacheGenerationMirror(env, getDb(env))).toBe(true);
    expect(values.get(KV_KEY)).toBe(stored());
    expect(await syncCacheGenerationMirror(env, getDb(env))).toBe(false);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });
});

describe("availability band transitions (band-only public stock)", () => {
  it.each([
    [20, 12, 5, false],
    [6, 5, 5, true],
    [3, 2, 5, false],
    [1, 0, 5, true],
    [0, 4, 5, true],
    [10, 1, null, false],
    [1, 0, null, true],
  ])("available %i -> %i (threshold %s) changes the band: %s", (before, after, threshold, expected) => {
    expect(hasBuyerAvailabilityBandTransition({
      availableBefore: before,
      availableAfter: after,
      lowStockThreshold: threshold,
    })).toBe(expected);
  });
});
