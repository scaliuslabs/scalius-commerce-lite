// Concurrent reservations of one SKU on a real PostgreSQL server (SERIALIZABLE
// batches through the production adapter). Two writers that claim the same
// next stock version must meet as a serialization failure the adapter retries,
// never as a unique violation that fails the batch: every reservation either
// succeeds or gets a domain answer, the ledger stays one movement per version,
// and the counters never oversell. Opt-in: SCALIUS_TEST_POSTGRES_URL.
import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { reserveStockBatch } from "./reserve";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("concurrent reservations on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("keeps one movement per version and never fails a batch on a version race", async () => {
    const { db, client } = await createNativePostgres({ label: "reserve_race" });
    await client.query(`
      INSERT INTO products (id, name, slug, price_minor) VALUES ('prod_hot', 'Hot', 'hot', 1000);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
        VALUES ('var_hot', 'prod_hot', 'PG-HOT', 1000, 12, 1, 1);
    `);

    const clients = 16;
    const results = await Promise.all(Array.from({ length: clients }, () =>
      reserveStockBatch(db, [{ variantId: "var_hot", quantity: 1 }])));

    // A batch that failed on the database (not on the stock it found) is the 500 a checkout would answer.
    expect(results.filter((result) => result.error === "Batch execution failed")).toEqual([]);
    const reserved = results.filter((result) => result.success).length;
    expect(reserved).toBeGreaterThan(0);
    expect(reserved).toBeLessThanOrEqual(12);

    const variant = (await client.query("SELECT stock, reserved_stock, stock_version FROM product_variants WHERE id = 'var_hot'")).rows[0];
    const movements = (await client.query(`SELECT count(*)::int AS n, count(DISTINCT stock_version_after)::int AS versions,
      coalesce(sum(reserved_stock_delta), 0)::int AS delta, coalesce(max(stock_version_after), 0)::int AS last
      FROM inventory_movements WHERE variant_id = 'var_hot'`)).rows[0];
    expect(Number(variant.reserved_stock)).toBe(reserved);
    expect(Number(variant.reserved_stock)).toBeLessThanOrEqual(Number(variant.stock));
    expect(movements).toEqual({ n: reserved, versions: reserved, delta: reserved, last: Number(variant.stock_version) });
  });
});
