// PostgreSQL parity for the store shape: the one bounded statement reads the
// same facts from the canonical PostgreSQL schema as from D1. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and
// drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl } from "@scalius/database/testing/postgres-native";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { readStoreShape } from "./store-shape";
import { STORE_SHAPE_EXPECTED, STORE_SHAPE_PRODUCTS, STORE_SHAPE_TREE } from "./store-shape.fixture";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.skipIf(!postgresUrl)("store shape on PostgreSQL", () => {
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
  });
});
