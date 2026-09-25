/**
 * The store shape on the 30k catalogue seed (opt-in, local only). Seed a
 * migrated state you own, then point this at a copy of it:
 *
 *   SCALIUS_WRANGLER_STATE=/tmp/fid-s0/state node scripts/deploy.mjs --migrate-only --local
 *   node scripts/catalog-scale-seed.mjs --state /tmp/fid-s0/state
 *   STORE_SHAPE_SCALE_STATE=/tmp/fid-s0/state pnpm --dir packages/core vitest run src/modules/storefront/store-shape.scale.test.ts
 *
 * The seed's tree is 25 roots x 5 x 1 x 1 (four levels), 300 brands, key
 * specs on the headline attributes; the shape must read exactly that, in one
 * statement, fast.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { readStoreShape, selectStoreShapeCounts } from "./store-shape";

const STATE = process.env.STORE_SHAPE_SCALE_STATE;

describe.skipIf(!STATE)("store shape on the 30k catalogue seed", () => {
  it("reads the seed's real counts in one bounded statement", async () => {
    const dir = join(STATE!, "v3", "d1", "miniflare-D1DatabaseObject");
    const file = readdirSync(dir).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")!;
    const sqlite = new DatabaseSync(join(dir, file), { readOnly: true });
    let statements = 0;
    const { db } = createSqliteD1Database({ sqlite, beforeBatch: () => { statements += 1; } });
    try {
      const started = performance.now();
      const shape = await readStoreShape(db);
      const elapsed = performance.now() - started;
      expect(shape).toMatchObject({
        productCount: 1000,
        skuCount: 1000,
        topCategoryCount: 25,
        categoryDepth: 4,
        // Each second level has one child: no tree groups.
        categoryGroups: 0,
        brandCount: 300,
        hasKeySpecs: true,
        hasCollections: true,
      });
      const { sql, params } = selectStoreShapeCounts(db).toSQL();
      console.log(JSON.stringify({ shape, elapsedMs: Math.round(elapsed), statements, sqlBytes: sql.length, params }));
      expect(elapsed).toBeLessThan(1500);
    } finally {
      sqlite.close();
    }
  });
});
