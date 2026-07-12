import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCollectionCacheTargets } from "./cache-invalidation";

describe("collection cache dependency resolution", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("matches canonical membership and featured dependencies within D1's binding limit", async () => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE collections (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        deleted_at INTEGER
      );
    `);

    const insert = sqlite.prepare(`
      INSERT INTO collections (id, config, is_active, deleted_at)
      VALUES (?, ?, ?, ?)
    `);
    insert.run("col_manual", JSON.stringify({
      source: "manual",
      productIds: ["prod_149"],
      categoryIds: ["cat_149"],
    }), 1, null);
    insert.run("col_dynamic", JSON.stringify({
      source: "dynamic",
      productIds: ["prod_149"],
      categoryIds: ["cat_149"],
    }), 1, null);
    insert.run("col_featured", JSON.stringify({
      source: "manual",
      productIds: ["other"],
      categoryIds: [],
      featuredProductId: "prod_149",
    }), 1, null);
    insert.run("col_inactive", JSON.stringify({
      source: "manual",
      productIds: ["prod_149"],
      categoryIds: [],
    }), 0, null);
    insert.run("col_deleted", JSON.stringify({
      source: "dynamic",
      productIds: [],
      categoryIds: ["cat_149"],
    }), 1, 1);
    insert.run("col_malformed", "{bad json", 1, null);

    const boundParameterCounts: number[] = [];
    const proxy = drizzle(async (query, params, method) => {
      boundParameterCounts.push(params.length);
      if (params.length > 100) {
        throw new Error(`D1 bound-parameter limit exceeded: ${params.length}`);
      }

      const statement = sqlite!.prepare(query);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: statement.get(...params) as unknown as unknown[] };
      }
      return { rows: statement.all(...params) as unknown as unknown[][] };
    });

    const targets = await resolveCollectionCacheTargets(
      proxy as unknown as Database,
      {
        productIds: Array.from({ length: 150 }, (_, index) => `prod_${index}`),
        categoryIds: Array.from({ length: 150 }, (_, index) => `cat_${index}`),
      },
    );

    expect(targets).toHaveLength(3);
    expect(targets).toEqual(expect.arrayContaining([
      { id: "col_manual" },
      { id: "col_dynamic" },
      { id: "col_featured" },
    ]));
    expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(100);
  });
});
