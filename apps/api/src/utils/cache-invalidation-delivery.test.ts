import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  recordCacheInvalidationRequest,
} from "./cache-invalidation-delivery";
import { flushPendingCacheInvalidations } from "./cache-invalidation";

describe("durable cache invalidation delivery", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE cache_invalidation_state (
        group_name TEXT PRIMARY KEY NOT NULL,
        requested_generation INTEGER NOT NULL DEFAULT 1,
        applied_generation INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        CHECK (requested_generation >= 1),
        CHECK (applied_generation >= 0),
        CHECK (applied_generation <= requested_generation),
        CHECK (attempt_count >= 0)
      );
    `);
    const execute = (query: string, params: SQLInputValue[], method: string) => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: statement.get(...params) as unknown as unknown[] };
      }
      return { rows: statement.all(...params) as unknown as unknown[][] };
    };
    db = drizzle(
      async (query, params, method) => execute(query, params, method),
      async (batch) => {
        sqlite.exec("BEGIN");
        try {
          const results = batch.map(({ sql: query, params, method }) =>
            execute(query, params, method));
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    ) as unknown as Database;
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function deliveryContext(
    purgeGroups: (groups: string[]) => Promise<void>,
  ) {
    return {
      waitUntil: vi.fn(),
      exports: { PublicApi: { purgeGroups } },
    };
  }

  const env = {
    PURGE_URL: "https://shop.example/api/purge-cache",
    PURGE_TOKEN: "secret",
  } as Env;

  it("coalesces repeated writes into one monotonic row per domain", async () => {
    await recordCacheInvalidationRequest(db, ["products", "products", "layout"]);
    await recordCacheInvalidationRequest(db, ["products"]);

    expect(sqlite.prepare(`
      SELECT group_name, requested_generation, applied_generation
      FROM cache_invalidation_state
      ORDER BY group_name
    `).all()).toEqual([
      { group_name: "layout", requested_generation: 1, applied_generation: 0 },
      { group_name: "products", requested_generation: 2, applied_generation: 0 },
    ]);
  });

  it("retries a partial delivery and acknowledges only a successful generation", async () => {
    await recordCacheInvalidationRequest(db, ["products"]);
    const purgeGroups = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })));

    await expect(flushPendingCacheInvalidations(
      db,
      env,
      deliveryContext(purgeGroups),
    )).resolves.toMatchObject({ scanned: 1, applied: 0, pending: 1 });
    expect(sqlite.prepare(`
      SELECT requested_generation, applied_generation, attempt_count, last_error
      FROM cache_invalidation_state WHERE group_name = 'products'
    `).get()).toEqual({
      requested_generation: 1,
      applied_generation: 0,
      attempt_count: 1,
      last_error: "storefront",
    });

    await expect(flushPendingCacheInvalidations(
      db,
      env,
      deliveryContext(purgeGroups),
    )).resolves.toMatchObject({ scanned: 1, applied: 1, pending: 0 });
    expect(sqlite.prepare(`
      SELECT requested_generation, applied_generation, attempt_count, last_error
      FROM cache_invalidation_state WHERE group_name = 'products'
    `).get()).toEqual({
      requested_generation: 1,
      applied_generation: 1,
      attempt_count: 0,
      last_error: null,
    });
  });
});
