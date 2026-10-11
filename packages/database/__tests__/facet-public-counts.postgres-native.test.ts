import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { connectNativePostgres, createPostgresDatabase } from "../src/postgres-adapter";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "../src/testing/postgres-native";
import { facetCountActual, facetCountMutations, facetCountOracle, facetCountSeed } from "./facet-public-counts-fixture";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("public facet counts on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("maintains exact counts across multi-row writes, UPSERTs, publication and cascades", async () => {
    const { db, client } = await createNativePostgres({ label: "facet_counts" });
    for (const statement of facetCountSeed.split(";").filter((s) => s.trim())) await db.run(sql.raw(statement));
    const assertCounts = async () => expect((await client.query(facetCountActual)).rows).toEqual((await client.query(facetCountOracle)).rows);
    await assertCounts();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("DELETE FROM products WHERE id='p2'");
    await client.query("ROLLBACK");
    await assertCounts();
    for (const mutation of facetCountMutations) {
      await db.run(sql.raw(mutation));
      await assertCounts();
    }
    expect((await client.query("SELECT count(*) AS n FROM product_facet_public_counts")).rows[0]).toEqual({ n: 5 });
  });

  it("retries concurrent first siblings so one public product is counted once", async () => {
    const pg = await createNativePostgres({ label: "facet_count_race" });
    for (const statement of facetCountSeed.split(";").filter((s) => s.trim())) await pg.db.run(sql.raw(statement));
    await pg.db.run(sql`UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'`);
    await pg.db.run(sql`DELETE FROM product_facet_values WHERE product_id='p1'`);
    let retries = 0;
    const contender = createPostgresDatabase(pg.url, {
      connect: connectNativePostgres,
      onSerializationRetry: () => { retries += 1; },
      sleep: async () => {},
    });
    const insert = (owner: string) => `INSERT INTO product_facet_values
      (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
      VALUES ('${owner}','p1','${owner}','option','option.race','same','Same')`;
    const left = new Client({ connectionString: pg.url });
    await left.connect();
    await left.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await left.query(insert("v1"));
      const pending = Promise.resolve(contender.run(sql.raw(insert("v2"))));
      let blocked = false;
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const { rows } = await pg.client.query(`SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname=current_database() AND pid != pg_backend_pid() AND wait_event_type='Lock'`);
        if (rows[0].n > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await left.query("COMMIT");
      await pending;
      expect(blocked).toBe(true);
      expect(retries).toBeGreaterThan(0);
      expect((await pg.client.query(facetCountActual)).rows).toEqual((await pg.client.query(facetCountOracle)).rows);
      expect((await pg.client.query("SELECT product_count FROM product_facet_public_counts WHERE facet_key='option.race'")).rows)
        .toEqual([{ product_count: 1 }]);
      expect((await pg.client.query("SELECT count(*) AS n FROM product_facet_values WHERE facet_key='option.race'")).rows)
        .toEqual([{ n: 2 }]);
    } finally { await left.query("ROLLBACK"); await left.end(); }
  });
});
