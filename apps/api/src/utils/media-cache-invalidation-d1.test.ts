import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveMediaDependentProductCachePage,
} from "./media-cache-invalidation";

describe("media dependent product cache resolution", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase() {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        poster_media_id TEXT
      );
      CREATE INDEX media_poster_id_idx ON media (poster_media_id);
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        category_id TEXT
      );
      CREATE TABLE product_media (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        media_id TEXT NOT NULL
      );
      CREATE INDEX product_media_asset_product_idx
        ON product_media (media_id, product_id);
    `);

    const boundParameterCounts: number[] = [];
    const db = drizzle(async (query, params, method) => {
      boundParameterCounts.push(params.length);
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

    return {
      db: db as unknown as Database,
      boundParameterCounts,
    };
  }

  it("deduplicates direct attachments and videos using the changed image as poster", async () => {
    const { db, boundParameterCounts } = createDatabase();
    sqlite!.exec(`
      INSERT INTO media (id, kind, poster_media_id) VALUES
        ('media_changed', 'image', NULL),
        ('media_video', 'video', 'media_changed'),
        ('media_corrupt_image', 'image', 'media_changed'),
        ('media_unrelated', 'image', NULL);
      INSERT INTO products (id, slug, category_id) VALUES
        ('prod_1', 'direct', 'cat_1'),
        ('prod_2', 'poster', 'cat_2'),
        ('prod_3', 'both', NULL),
        ('prod_4', 'invalid-image-poster', NULL),
        ('prod_5', 'unrelated', NULL);
      INSERT INTO product_media (id, product_id, media_id) VALUES
        ('pmed_1', 'prod_1', 'media_changed'),
        ('pmed_2', 'prod_2', 'media_video'),
        ('pmed_3a', 'prod_3', 'media_changed'),
        ('pmed_3b', 'prod_3', 'media_video'),
        ('pmed_4', 'prod_4', 'media_corrupt_image'),
        ('pmed_5', 'prod_5', 'media_unrelated');
    `);

    const page = await resolveMediaDependentProductCachePage(
      db,
      "media_changed",
    );

    expect(page).toEqual({
      subjects: [
        { productId: "prod_1", slug: "direct", categoryId: "cat_1" },
        { productId: "prod_2", slug: "poster", categoryId: "cat_2" },
        { productId: "prod_3", slug: "both", categoryId: null },
      ],
      nextProductId: null,
    });
    expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(100);
  });

  it("walks high-reuse assets in pages that preserve every exact HTML target", async () => {
    const { db, boundParameterCounts } = createDatabase();
    sqlite!.exec("INSERT INTO media (id, kind, poster_media_id) VALUES ('media_shared', 'image', NULL)");
    const insertProduct = sqlite!.prepare(
      "INSERT INTO products (id, slug, category_id) VALUES (?, ?, NULL)",
    );
    const insertAssociation = sqlite!.prepare(
      "INSERT INTO product_media (id, product_id, media_id) VALUES (?, ?, 'media_shared')",
    );
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index).padStart(3, "0");
      insertProduct.run(`prod_${suffix}`, `product-${suffix}`);
      insertAssociation.run(`pmed_${suffix}`, `prod_${suffix}`);
    }

    const first = await resolveMediaDependentProductCachePage(db, "media_shared");
    expect(first.subjects).toHaveLength(20);
    expect(first.nextProductId).toBe("prod_019");

    const second = await resolveMediaDependentProductCachePage(
      db,
      "media_shared",
      first.nextProductId!,
    );
    expect(second.subjects.map((subject) => subject.productId)).toEqual([
      "prod_020",
      "prod_021",
      "prod_022",
      "prod_023",
      "prod_024",
    ]);
    expect(second.nextProductId).toBeNull();
    expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(100);
  });
});
