// PostgreSQL parity for the store shape: the one bounded statement reads the
// same facts from the canonical PostgreSQL schema as from D1. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and
// drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { readCategoryNavigation } from "../navigation";
import { readStoreShape } from "./store-shape";
import { STORE_SHAPE_EXPECTED, STORE_SHAPE_PRODUCTS, STORE_SHAPE_TREE } from "./store-shape.fixture";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.skipIf(!postgresUrl)("store shape on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("reads the same facts as D1", async () => {
    const { db, client } = await createNativePostgres({ label: "store_shape" });

    await expect(readStoreShape(db)).resolves.toMatchObject({ topCategoryCount: 0, categoryDepth: 0, categoryGroups: 0, brandCount: 0 });
    for (const statement of [...STORE_SHAPE_TREE, ...STORE_SHAPE_PRODUCTS]) await client.query(statement);
    await rebuildCatalogProjections(db);
    await expect(readStoreShape(db)).resolves.toMatchObject(STORE_SHAPE_EXPECTED);

    for (const [write, hasContentBlocks] of [
      ["INSERT INTO product_content_blocks (id, product_id, placement, position, type, version, settings) VALUES ('pcb_shape_test', 'p_f', 'tabs', 0, 'rich-text', 1, '{}')", false],
      ["UPDATE product_content_blocks SET placement = 'after-description'", true],
      ["UPDATE product_content_blocks SET type = 'pack-picker'", false],
      ["UPDATE product_content_blocks SET type = 'faq', placement = 'tabs'", true],
      ["UPDATE products SET is_active = 0 WHERE id = 'p_f'", false],
      ["UPDATE products SET is_active = 1 WHERE id = 'p_f'", true],
      ["UPDATE products SET deleted_at = 1780000000 WHERE id = 'p_f'", false],
      ["UPDATE products SET deleted_at = NULL WHERE id = 'p_f'", true],
      ["DELETE FROM product_content_blocks", false],
    ] as const) {
      await client.query(write);
      await rebuildCatalogProjections(db);
      await expect(readStoreShape(db)).resolves.toMatchObject({ hasContentBlocks });
    }

    await client.query("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    await client.query(`INSERT INTO product_attributes (id, name, slug, key_spec) VALUES ('attr_cpu', 'Processor', 'processor', 1)`);
    await client.query(`INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_f', 'p_f', 'attr_cpu', 'M4')`);
    await expect(readStoreShape(db)).resolves.toMatchObject({ categoryDepth: 4, hasKeySpecs: true });

    expect((await readCategoryNavigation(db)).nodes.map(({ id }) => id)).toEqual(["A", "F", "A1", "A2", "A1a", "A2a", "A2a1"]);
    for (const [write, ids] of [
      ["UPDATE categories SET status = 'draft' WHERE id = 'A1a'", ["A", "F", "A2", "A2a", "A2a1"]],
      ["UPDATE categories SET deleted_at = 1 WHERE id = 'A2a1'", ["F"]],
      ["UPDATE categories SET status = 'published' WHERE id = 'A1a'", ["A", "F", "A1", "A1a"]],
      ["UPDATE categories SET status = 'internal' WHERE id = 'A1'", ["A", "F"]],
      ["UPDATE categories SET status = 'published', deleted_at = 1 WHERE id = 'A1'", ["A", "F"]],
      ["UPDATE categories SET deleted_at = 1 WHERE id = 'A'", ["F"]],
    ] as const) {
      await client.query(write);
      expect((await readCategoryNavigation(db)).nodes.map(({ id }) => id)).toEqual(ids);
      expect((await readStoreShape(db)).topCategoryCount).toBe(ids.filter((id) => id === "A" || id === "F").length);
    }

    for (const [write, hasDigitalLines] of [
      ["UPDATE product_variants SET fulfillment_kind = 'digital' WHERE id = 'v_p_f'", true],
      ["UPDATE products SET is_active = 0 WHERE id = 'p_f'", false],
      ["UPDATE products SET is_active = 1 WHERE id = 'p_f'", true],
      ["UPDATE products SET deleted_at = 1780000000 WHERE id = 'p_f'", false],
      ["UPDATE products SET deleted_at = NULL WHERE id = 'p_f'", true],
      ["UPDATE product_variants SET deleted_at = 1780000000 WHERE id = 'v_p_f'", false],
    ] as const) {
      await client.query(write);
      const original = await client.query(`SELECT count(*) AS present FROM (
        SELECT 1 FROM product_variants v INNER JOIN products p ON p.id = v.product_id
        WHERE v.fulfillment_kind = 'digital' AND v.deleted_at IS NULL
          AND p.deleted_at IS NULL AND p.is_active = 1 LIMIT 1
      ) AS digital_skus`);
      expect(Number(original.rows[0].present)).toBe(Number(hasDigitalLines));
      await expect(readStoreShape(db)).resolves.toMatchObject({ hasDigitalLines });
    }
  });
});
