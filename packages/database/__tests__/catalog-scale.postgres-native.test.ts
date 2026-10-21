// The per-scope facet counts (0174) on PostgreSQL: the compiled triggers keep
// the same exact counts and in-scope samples as on D1 through every write.
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "../src/testing/postgres-native";
import { scopeCountsActual, scopeCountsBadSamples, scopeCountsMutations, scopeCountsOracle, scopeCountsSeed } from "./catalog-scale-fixture";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("per-scope facet counts on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("keeps exact counts and in-scope samples through every write", async () => {
    const { db, client } = await createNativePostgres({ label: "facet_scope_counts" });
    for (const statement of scopeCountsSeed.split(";").filter((s) => s.trim())) await db.run(sql.raw(statement));
    const assertCounts = async (step: string) => {
      expect((await client.query(scopeCountsActual)).rows, step).toEqual((await client.query(scopeCountsOracle)).rows);
      expect((await client.query(scopeCountsBadSamples)).rows, step).toEqual([]);
    };
    await assertCounts("seed");
    for (const mutation of scopeCountsMutations) {
      await db.run(sql.raw(mutation));
      await assertCounts(mutation);
    }
  });
});
