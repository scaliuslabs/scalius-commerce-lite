import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { connectNativePostgres, createPostgresDatabase } from "../src/postgres-adapter";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "../src/testing/postgres-native";
import { recommendationProjectionActual, recommendationProjectionMutations, recommendationProjectionOracle, recommendationProjectionSeed } from "./recommendation-order-products-fixture";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("recommendation pairs on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("keeps canonical pair/buyer results through actual adapter writes and rollback", async () => {
    const { db, client } = await createNativePostgres({ label: "recommendation_pairs" });
    for (const statement of recommendationProjectionSeed.split(";").filter((s) => s.trim())) await db.run(sql.raw(statement));
    const assertProjection = async () => expect((await client.query(recommendationProjectionActual)).rows).toEqual((await client.query(recommendationProjectionOracle)).rows);
    await assertProjection();
    const sequence = async () => Number((await client.query("SELECT max(seq) AS seq FROM cache_dep WHERE dep='recommendation-signals'")).rows[0].seq);
    const beforeEmail = await sequence();
    await db.run(sql`UPDATE orders SET customer_email='next@example.com' WHERE id='b'`);
    expect(await sequence()).toBeGreaterThan(beforeEmail);
    const beforeLineTime = await sequence();
    await db.run(sql`UPDATE order_items SET created_at=created_at+1 WHERE id='b1'`);
    expect(await sequence()).toBeGreaterThan(beforeLineTime);
    for (const mutation of recommendationProjectionMutations) { await db.run(sql.raw(mutation)); await assertProjection(); }
    const before = (await client.query(recommendationProjectionActual)).rows;
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("DELETE FROM orders");
    await client.query("ROLLBACK");
    expect((await client.query(recommendationProjectionActual)).rows).toEqual(before);
  });

  it.each([
    { name: "duplicate delete and insert", setup: "SELECT 1", left: "DELETE FROM order_items WHERE id='a1'",
      right: "INSERT INTO order_items(id,order_id,product_id,quantity) VALUES ('new_line','a','p1',1)" },
    { name: "last duplicate delete and insert", setup: "DELETE FROM order_items WHERE id='a1'", left: "DELETE FROM order_items WHERE id='a2'",
      right: "INSERT INTO order_items(id,order_id,product_id,quantity) VALUES ('new_line','a','p1',1)" },
    { name: "eligibility change and insert", setup: "SELECT 1", left: "UPDATE orders SET status='cancelled' WHERE id='b'",
      right: "INSERT INTO order_items(id,order_id,product_id,quantity) VALUES ('new_line','b','p3',1)" },
    { name: "buyer/date change and insert", setup: "SELECT 1", left: "UPDATE orders SET customer_email='Concurrent@Example.COM',created_at=999 WHERE id='b'",
      right: "INSERT INTO order_items(id,order_id,product_id,quantity) VALUES ('new_line','b','p3',1)" },
  ])("retries concurrent $name without stale or missing pairs", async (race) => {
    const pg = await createNativePostgres({ label: "recommendation_race" });
    for (const statement of recommendationProjectionSeed.split(";").filter((s) => s.trim())) await pg.db.run(sql.raw(statement));
    await pg.db.run(sql.raw(race.setup));
    let retries = 0;
    const db = createPostgresDatabase(pg.url, {
      connect: connectNativePostgres, onSerializationRetry: () => { retries += 1; }, sleep: async () => {},
    });
    // Hold only the dependency clock lock the deferred triggers take at commit. Both real adapter
    // writes reach their source/projection work before either can commit.
    const blocker = new Client({ connectionString: pg.url });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('scalius-cache-dep-clock', 0))");
    const pending = Promise.allSettled([Promise.resolve(db.run(sql.raw(race.left))), Promise.resolve(db.run(sql.raw(race.right)))]);
    let overlapped = false;
    try {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const { rows } = await pg.client.query(`SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname=current_database() AND pid != pg_backend_pid() AND wait_event_type='Lock'`);
        if (Number(rows[0].n) >= 2) { overlapped = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocker.query("COMMIT");
      const results = await pending;
      for (const result of results) { if (result.status === "rejected") throw result.reason; }
      expect(overlapped).toBe(true);
      expect(retries).toBeGreaterThan(0);
      expect((await pg.client.query(recommendationProjectionActual)).rows).toEqual((await pg.client.query(recommendationProjectionOracle)).rows);
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); await pending; }
  });
});
