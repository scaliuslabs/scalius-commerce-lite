import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { CollectionRevisionConflictError, createCollection, updateCollectionProducts } from "./collections.service";
import { createCollectionSchema, updateCollectionProductsSchema } from "./collections.validation";

describe("manual collection membership on D1", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function setup(config: Record<string, unknown>, isActive = 1) {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug, is_active, deleted_at) VALUES
        ('prod_a', 'A', 1000, 'a', 1, NULL),
        ('prod_b', 'B', 1000, 'b', 1, NULL),
        ('prod_c', 'C', 1000, 'c', 0, NULL),
        ('ops006_product', 'Imported', 1000, 'imported', 1, NULL),
        ('prod_gone', 'Gone', 1000, 'gone', 1, 1700000000);
    `);
    sqlite.prepare(`
      INSERT INTO collections (id, name, presentation, config, is_active, version)
      VALUES ('col_eid', 'Eid picks', 'grid', ?, ?, 3)
    `).run(JSON.stringify(config), isActive);
    return harness.db;
  }

  function stored() {
    const row = sqlite!.prepare("SELECT config, version FROM collections WHERE id = 'col_eid'").get() as {
      config: string;
      version: number;
    };
    return { productIds: JSON.parse(row.config).productIds as string[], version: row.version };
  }

  const input = (body: Record<string, unknown>) => updateCollectionProductsSchema.parse({ expectedVersion: 3, ...body });

  it("appends new products in order, skips unknown or trashed ids and advances the version", async () => {
    const db = setup({ source: "manual", productIds: ["prod_a"], categoryIds: [] });

    const result = await updateCollectionProducts(db, "col_eid", input({
      add: ["prod_c", "prod_a", "prod_missing", "prod_gone", "ops006_product", "prod_b", "prod_c"],
    }));

    expect(result).toEqual({ id: "col_eid", version: 4 });
    // Ids are opaque: an existing product whose id lacks the usual prefix still counts.
    expect(stored()).toEqual({ productIds: ["prod_a", "prod_c", "ops006_product", "prod_b"], version: 4 });
  });

  it("removes products and keeps the rest in place", async () => {
    const db = setup({ source: "manual", productIds: ["prod_a", "prod_b", "prod_c"], categoryIds: [] });

    await updateCollectionProducts(db, "col_eid", input({ remove: ["prod_b", "prod_missing"] }));

    expect(stored()).toEqual({ productIds: ["prod_a", "prod_c"], version: 4 });
  });

  it("refuses automatic collections, the 90-product limit, emptying an active one and stale versions", async () => {
    const db = setup({ source: "dynamic", productIds: [], categoryIds: ["cat_a"] });
    await expect(updateCollectionProducts(db, "col_eid", input({ add: ["prod_a"] })))
      .rejects.toThrow("This collection picks products automatically. Change its rule instead.");

    sqlite!.prepare("UPDATE collections SET config = ? WHERE id = 'col_eid'").run(JSON.stringify({
      source: "manual",
      categoryIds: [],
      productIds: Array.from({ length: 90 }, (_, index) => `prod_x${index}`),
    }));
    await expect(updateCollectionProducts(db, "col_eid", input({ add: ["prod_a"] })))
      .rejects.toMatchObject({ message: "This collection can hold 90 products. Remove some first.", details: { field: "products" } });

    sqlite!.prepare("UPDATE collections SET config = ? WHERE id = 'col_eid'").run(JSON.stringify({
      source: "manual",
      categoryIds: [],
      productIds: ["prod_a"],
    }));
    await expect(updateCollectionProducts(db, "col_eid", input({ remove: ["prod_a"] })))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(updateCollectionProducts(db, "col_eid", { expectedVersion: 2, add: ["prod_b"], remove: [] }))
      .rejects.toBeInstanceOf(CollectionRevisionConflictError);
    expect(stored()).toEqual({ productIds: ["prod_a"], version: 3 });
  });

  it("activates only with products that exist, whatever their id looks like", async () => {
    const db = setup({ source: "manual", productIds: [], categoryIds: [] }, 0);
    const collection = (productIds: string[]) => createCollectionSchema.parse({
      name: "Imported picks",
      presentation: "grid",
      isActive: true,
      config: { source: "manual", productIds },
    });

    await expect(createCollection(db, collection(["cat_footwear"]))).rejects.toBeInstanceOf(ValidationError);
    await expect(createCollection(db, collection(["ops006_product", "prod_a"]))).resolves.toMatchObject({ isActive: true });
  });
});
