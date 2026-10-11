import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { safeBatch } from "../src/batch-helper";
import { connectNativePostgres, createPostgresDatabase } from "../src/postgres-adapter";
import { productBuyerState } from "../src/schema";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT, type NativePostgres } from "../src/testing/postgres-native";

afterAll(closeNativePostgres);

const actual = "SELECT dimension,value_id,product_count FROM product_buyer_public_counts WHERE product_count>0 ORDER BY 1,2";
// Source-only oracle: neither the generated delta SQL nor the counters supply an expected value.
const oracle = `SELECT 'brand' AS dimension,brand_id AS value_id,count(*) AS product_count
  FROM product_buyer_state WHERE is_public=1 AND brand_id IS NOT NULL GROUP BY brand_id
  UNION ALL SELECT 'category',category_id,count(*)
  FROM product_buyer_state WHERE is_public=1 AND category_id IS NOT NULL GROUP BY category_id
  ORDER BY 1,2`;
const columns = "product_id,is_public,brand_id,category_id,product_created_at,sku_id,from_minor,to_minor,base_minor,refreshed_at";
const buyer = (id: string, public_: boolean, brand: string | null, category: string | null) => ({
  productId: id, isPublic: public_, brandId: brand, categoryId: category,
  productCreatedAt: new Date(1000), skuId: `sku_${id}`, fromMinor: 100, toMinor: 100, baseMinor: 100,
  refreshedAt: new Date(1000),
});
async function seed(pg: NativePostgres) {
  await pg.db.run(sql`INSERT INTO products(id,name,slug) VALUES
    ('p1','One','one'),('p2','Two','two'),('p3','Three','three'),('p4','Four','four'),('p5','Five','five'),('p6','Six','six')`);
}
async function assertCounts(pg: NativePostgres) {
  expect((await pg.client.query(actual)).rows).toEqual((await pg.client.query(oracle)).rows);
}

describe.runIf(nativePostgresUrl())("public buyer dimension counts on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("keeps raw dimensions exact across multi-row publication, moves, UPSERTs, ignored conflicts and cascades", async () => {
    const pg = await createNativePostgres({ label: "buyer_counts" });
    await seed(pg);
    await pg.db.insert(productBuyerState).values([
      buyer("p1", true, "shared", "shared"), buyer("p2", true, "shared", "other"),
      buyer("p3", false, "shared", "shared"), buyer("p4", true, null, null),
      buyer("p5", true, "other", null),
    ]);
    await assertCounts(pg);
    expect((await pg.client.query(actual)).rows).toEqual([
      { dimension: "brand", value_id: "other", product_count: 1 },
      { dimension: "brand", value_id: "shared", product_count: 2 },
      { dimension: "category", value_id: "other", product_count: 1 },
      { dimension: "category", value_id: "shared", product_count: 1 },
    ]);
    const mutations = [
      `INSERT INTO product_buyer_state (${columns}) VALUES ('p1',1,'ignored','ignored',1,'sku_p1',100,100,100,1) ON CONFLICT(product_id) DO NOTHING`,
      "UPDATE product_buyer_state SET is_public=1 WHERE product_id='p3'",
      "UPDATE product_buyer_state SET brand_id=CASE WHEN brand_id='shared' THEN 'other' ELSE 'shared' END WHERE is_public=1",
      "UPDATE product_buyer_state SET category_id='joined' WHERE is_public=1",
      "UPDATE product_buyer_state SET brand_id=NULL,category_id=NULL WHERE product_id IN ('p1','p2')",
      "UPDATE product_buyer_state SET is_public=0,brand_id='private',category_id='private' WHERE product_id='p3'",
      "UPDATE product_buyer_state SET is_public=1 WHERE product_id='p3'",
      `INSERT INTO product_buyer_state (${columns}) VALUES ('p1',1,'upsert','upsert',1,'sku_p1',100,100,100,1)
        ON CONFLICT(product_id) DO UPDATE SET brand_id=excluded.brand_id,category_id=excluded.category_id`,
      "UPDATE product_buyer_state SET product_id='p6' WHERE product_id='p5'",
      "UPDATE product_buyer_state SET from_minor=99,available_for_sale=1,refreshed_at=2",
      "DELETE FROM products WHERE id='p3'",
      "DELETE FROM product_buyer_state WHERE product_id='p6'",
      "DELETE FROM products",
    ];
    for (const mutation of mutations) { await pg.db.run(sql.raw(mutation)); await assertCounts(pg); }
    expect((await pg.client.query(actual)).rows).toEqual([]);
  });

  it("rolls source and counter changes back together when a later batch statement fails", async () => {
    const pg = await createNativePostgres({ label: "buyer_counts_rollback" });
    await seed(pg);
    await pg.db.insert(productBuyerState).values([buyer("p1", true, "shared", "shared"), buyer("p2", true, "shared", "shared")]);
    const before = (await pg.client.query(actual)).rows;
    await expect(safeBatch(pg.db, [
      pg.db.update(productBuyerState).set({ brandId: "moved", categoryId: "moved" }).where(eq(productBuyerState.productId, "p1")),
      pg.db.update(productBuyerState).set({ discountDepthBps: -1 }).where(eq(productBuyerState.productId, "p2")),
    ] as const)).rejects.toThrow();
    expect((await pg.client.query(actual)).rows).toEqual(before);
    await assertCounts(pg);
    await pg.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await pg.client.query("DELETE FROM products WHERE id='p1'");
      await assertCounts(pg);
    } finally { await pg.client.query("ROLLBACK"); }
    expect((await pg.client.query(actual)).rows).toEqual(before);
    await assertCounts(pg);
  });

  it.each(["insert", "publish", "move", "delete"] as const)("retries two different buyer rows that %s into the same counters without lost deltas", async (operation) => {
    const pg = await createNativePostgres({ label: `buyer_counts_${operation}` });
    await seed(pg);
    // A counter-free row witnesses rollback/replay of the whole batch, not just the contested statement.
    await pg.db.insert(productBuyerState).values(buyer("p3", false, null, null));
    if (operation !== "insert") await pg.db.insert(productBuyerState).values([
      buyer("p1", operation !== "publish", operation === "move" ? "left" : "shared", operation === "move" ? "left" : "shared"),
      buyer("p2", operation !== "publish", operation === "move" ? "right" : "shared", operation === "move" ? "right" : "shared"),
    ]);
    if (operation === "publish") await pg.db.insert(productBuyerState).values(buyer("p4", true, "shared", "shared"));
    let retries = 0;
    const db = createPostgresDatabase(pg.url, { connect: connectNativePostgres, onSerializationRetry: () => { retries++; }, sleep: async () => {} });
    const left = new Client({ connectionString: pg.url });
    await left.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await left.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const pid = Number((await left.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const mutation = operation === "insert"
        ? `INSERT INTO product_buyer_state (${columns}) VALUES ('p1',1,'shared','shared',1,'sku_p1',100,100,100,1)`
        : operation === "delete" ? "DELETE FROM product_buyer_state WHERE product_id='p1'"
          : "UPDATE product_buyer_state SET is_public=1,brand_id='shared',category_id='shared' WHERE product_id='p1'";
      await left.query(mutation);
      const right = operation === "insert" ? db.insert(productBuyerState).values(buyer("p2", true, "shared", "shared"))
        : operation === "delete" ? db.delete(productBuyerState).where(eq(productBuyerState.productId, "p2"))
          : db.update(productBuyerState).set({ isPublic: true, brandId: "shared", categoryId: "shared" }).where(eq(productBuyerState.productId, "p2"));
      // Attach rejection handling immediately while the test observes the real database lock wait.
      pending = safeBatch(db, [
        db.update(productBuyerState).set({ refreshedAt: sql`${productBuyerState.refreshedAt}+1` }).where(eq(productBuyerState.productId, "p3")),
        right,
      ] as const);
      const settled = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      let blocked = false;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const { rows } = await pg.client.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [pid]);
        if (Number(rows[0].n) > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await left.query("COMMIT");
      const result = await settled;
      if (!result.ok) throw result.error;
      expect(blocked).toBe(true);
      expect(retries).toBeGreaterThan(0);
      await assertCounts(pg);
      expect((await pg.client.query("SELECT refreshed_at FROM product_buyer_state WHERE product_id='p3'")).rows).toEqual([{ refreshed_at: 2 }]);
      const n = operation === "delete" ? 0 : operation === "publish" ? 3 : 2;
      expect((await pg.client.query("SELECT dimension,product_count FROM product_buyer_public_counts WHERE value_id='shared' ORDER BY dimension")).rows)
        .toEqual([{ dimension: "brand", product_count: n }, { dimension: "category", product_count: n }]);
    } finally {
      await left.query("ROLLBACK").catch(() => undefined);
      await left.end();
      await pending?.catch(() => undefined);
    }
  });
});
