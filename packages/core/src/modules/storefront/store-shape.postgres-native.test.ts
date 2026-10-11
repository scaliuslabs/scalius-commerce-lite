// PostgreSQL parity for the store shape: the one bounded statement reads the
// same facts from the canonical PostgreSQL schema as from D1. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and
// drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { rebuildCatalogProjections } from "../products/catalog-projections";
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

    await client.query("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    await client.query(`INSERT INTO product_attributes (id, name, slug, key_spec) VALUES ('attr_cpu', 'Processor', 'processor', 1)`);
    await client.query(`INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_f', 'p_f', 'attr_cpu', 'M4')`);
    await expect(readStoreShape(db)).resolves.toMatchObject({ categoryDepth: 4, hasKeySpecs: true });

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
