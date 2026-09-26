// The store shape counts what a buyer can reach: published roots with public
// products, tree levels holding public products (every ancestor published),
// tree groups, published brands with public products and key specs on
// public products. One statement in the layout batch.
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { safeBatch } from "@scalius/database/client";
import { withDependencyScope } from "../../cache-deps";
import { EMPTY_STORE_SHAPE } from "@scalius/shared/storefront-theme";
import { describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { getLayoutData } from "./storefront.service";
import { readStoreShape } from "./store-shape";
import { planHomeBrands } from "../catalog/home-brands";
import { STORE_SHAPE_EXPECTED, STORE_SHAPE_PRODUCTS, STORE_SHAPE_TREE } from "./store-shape.fixture";

async function seeded() {
  const { sqlite, db } = createSqliteD1Database();
  for (const statement of [...STORE_SHAPE_TREE, ...STORE_SHAPE_PRODUCTS]) sqlite.exec(statement);
  await rebuildCatalogProjections(db);
  return { sqlite, db };
}

describe("store shape", () => {
  it("reads nothing on an empty store", async () => {
    const { db } = createSqliteD1Database();
    await expect(readStoreShape(db)).resolves.toEqual(EMPTY_STORE_SHAPE);
  });

  it("counts reachable roots, levels, groups and brands", async () => {
    const { db } = await seeded();
    const shape = await readStoreShape(db);
    expect(shape).toMatchObject(STORE_SHAPE_EXPECTED);
    // The layout batch serves the same shape in one statement.
    expect((await getLayoutData(db)).storeShape).toEqual(shape);
  });

  it("tracks shape and brand membership without invalidating for product content, price or stock", async () => {
    const { sqlite, db } = await seeded();
    sqlite.exec(`
      INSERT INTO media (id, filename, kind, object_key, size, mime_type, status)
        VALUES ('m_brand', 'brand.png', 'image', 'media/brand.png', 1, 'image/png', 'ready');
      UPDATE brands SET logo_media_id = 'm_brand' WHERE id = 'brd_public';
    `);
    const shape = await withDependencyScope(() => readStoreShape(db), { strict: true });
    const brands = await withDependencyScope(async () => {
      const plan = planHomeBrands(db, 24);
      return plan.resolve(await safeBatch(db, plan.statements), 0);
    }, { strict: true });
    for (const read of [shape, brands]) {
      expect(read.dependencies.keys).toContain("lm:all");
      expect(read.dependencies.coarseTables).toEqual([]);
    }
    const bumped = (write: string) => {
      const { seq } = sqlite.prepare("SELECT seq FROM cache_clock").get() as { seq: number };
      sqlite.exec(write);
      return (sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ?").all(seq) as Array<{ dep: string }>)
        .map(({ dep }) => dep);
    };
    const unrelated = bumped(`
      UPDATE products SET name = 'Edited', description = 'New copy' WHERE id = 'p_a1a';
      UPDATE product_variants SET price_minor = 1200, stock = 0 WHERE product_id = 'p_a1a';
      UPDATE product_buyer_state SET from_minor = 1200, to_minor = 1200, base_minor = 1200,
        available_for_sale = 0, availability_band = 'out_of_stock' WHERE product_id = 'p_a1a';
    `);
    for (const read of [shape, brands]) {
      expect(read.dependencies.keys.filter((key) => unrelated.includes(key))).toEqual([]);
    }
    for (const write of [
      "UPDATE product_buyer_state SET category_id = 'F' WHERE product_id = 'p_a1a'",
      "UPDATE product_buyer_state SET brand_id = 'brd_unused' WHERE product_id = 'p_a1a'",
      "UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'p_a1a'",
    ]) {
      const changed = bumped(write);
      expect(changed).toContain("lm:all");
      expect(changed).not.toContain("lm:shape");
    }
    expect((await readStoreShape(db)).brandCount).toBe(0);
  });

  it("follows publication and product changes", async () => {
    const { sqlite, db } = await seeded();
    // Publishing A2 makes the fourth level reachable.
    sqlite.exec("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    expect((await readStoreShape(db)).categoryDepth).toBe(4);
    // A1b leaving A1 with one child: one group left.
    sqlite.exec("UPDATE categories SET status = 'draft' WHERE id = 'A1b'");
    expect((await readStoreShape(db)).categoryGroups).toBe(1);
    // A trashed root drops out with its subtree.
    sqlite.exec("UPDATE categories SET deleted_at = 1 WHERE id = 'F'");
    expect((await readStoreShape(db)).topCategoryCount).toBe(1);
  });

  it("sees key specs only on public products", async () => {
    const { sqlite, db } = await seeded();
    sqlite.exec(`
      INSERT INTO product_attributes (id, name, slug, key_spec) VALUES ('attr_cpu', 'Processor', 'processor', 1), ('attr_note', 'Note', 'note', 0);
      INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_off', 'p_off', 'attr_cpu', 'M4');
      INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_note', 'p_f', 'attr_note', 'x');
    `);
    expect((await readStoreShape(db)).hasKeySpecs).toBe(false);
    sqlite.exec("INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_f', 'p_f', 'attr_cpu', 'M4')");
    expect((await readStoreShape(db)).hasKeySpecs).toBe(true);
    sqlite.exec("UPDATE product_attributes SET deleted_at = 1 WHERE id = 'attr_cpu'");
    expect((await readStoreShape(db)).hasKeySpecs).toBe(false);
  });
});
