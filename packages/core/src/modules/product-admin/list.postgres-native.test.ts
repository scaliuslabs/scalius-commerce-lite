// PostgreSQL parity for the dashboard products list: its page summary sums
// tracked SKUs, and a PostgreSQL boolean column is a bigint there, so every
// CASE WHEN on it compares `= 1`. Opt-in: point SCALIUS_TEST_POSTGRES_URL at
// a disposable server; the test creates and drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "@scalius/database/client";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";

import { listProducts } from "./read";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.runIf(postgresUrl)("products list on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    it("lists products with their tracked stock summary", async () => {
        const { client, url } = await createNativePostgres({ label: "product-list" });
        const db = getDb({ DATABASE_PROVIDER: "postgres", POSTGRES_DATABASE_URL: url } as never);
        await client.query(`
            INSERT INTO products (id, name, slug, price_minor, is_active, created_at, updated_at)
            VALUES ('prod_a', 'Cotton shirt', 'cotton-shirt', 1000, 1, 1700000001, 1700000001),
                   ('prod_b', 'Linen shirt', 'linen-shirt', 2000, 1, 1700000002, 1700000002);
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, track_inventory, is_default, created_at, updated_at)
            VALUES ('var_a', 'prod_a', 'SHIRT-A', 1000, 7, 0, 1, 1, 1700000001, 1700000001),
                   ('var_b', 'prod_b', 'SHIRT-B', 2000, 4, 0, 0, 1, 1700000002, 1700000002);
        `);

        const result = await listProducts(db, { limit: 10, sort: "name", order: "asc" });
        expect(result.products.map((product) => product.id)).toEqual(["prod_a", "prod_b"]);
    });
});
