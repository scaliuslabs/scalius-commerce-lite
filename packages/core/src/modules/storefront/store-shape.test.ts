// The store shape counts what a buyer can reach: published roots with public
// products, tree levels holding public products (every ancestor published),
// tree groups, published brands with public products and key specs on
// public products. One statement in the layout batch.
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { EMPTY_STORE_SHAPE } from "@scalius/shared/storefront-theme";
import { describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { getLayoutData } from "./storefront.service";
import { readStoreShape } from "./store-shape";
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
