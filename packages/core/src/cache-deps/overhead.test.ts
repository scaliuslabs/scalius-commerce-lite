/**
 * Micro-benchmark: what read recording costs per statement. Bounds are loose
 * (an order of magnitude above measured) so a loaded CI host stays green; the
 * numbers are printed for the record.
 */
import { and, eq, inArray } from "drizzle-orm";
import { observeStatement, statementTables } from "@scalius/database/read-observer";
import { productBuyerState, products, productVariants } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";

import { deps, withDependencyScope } from "./index";

/** A typical public listing read as Drizzle renders it. */
function drizzleListingSql(db: ReturnType<typeof createSqliteD1Database>["db"]): string {
  return db
    .select({ id: products.id, name: products.name, sku: productVariants.sku, band: productBuyerState.availabilityBand })
    .from(products)
    .innerJoin(productBuyerState, eq(productBuyerState.productId, products.id))
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .where(and(eq(productBuyerState.isPublic, true), inArray(products.id, ["a", "b", "c"])))
    .toSQL().sql;
}

/** Fresh, equal, flat copies: Drizzle builds a new SQL string per query, so no hash is cached. */
function freshCopies(text: string, count: number): string[] {
  return Array.from({ length: count }, () => text.split("").join(""));
}

function nsPerOp(iterations: number, run: (index: number) => void): number {
  const samples: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) run(round * iterations + index);
    samples.push(Number(process.hrtime.bigint() - start) / iterations);
  }
  return samples.sort((a, b) => a - b)[2]!;
}

async function usPerQuery(iterations: number, run: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) await run();
    samples.push(Number(process.hrtime.bigint() - start) / iterations / 1_000);
  }
  return samples.sort((a, b) => a - b)[2]!;
}

describe("read recording overhead", () => {
  it("is negligible per statement, with and without a scope", async () => {
    const { db } = createSqliteD1Database();
    const listingSql = drizzleListingSql(db);
    expect(statementTables(listingSql)).toEqual(["products", "product_buyer_state", "product_variants"]);

    const iterations = 200_000;
    const copies = freshCopies(listingSql, 1_000);

    const noScope = nsPerOp(iterations, (index) => observeStatement(copies[index % copies.length]!));

    let inScope = 0;
    let declare = 0;
    await withDependencyScope(() => {
      inScope = nsPerOp(iterations, (index) => observeStatement(copies[index % copies.length]!));
      declare = nsPerOp(iterations, (index) => deps.product(`prod_${index & 255}`));
    }, { log: () => undefined });

    const distinct = Array.from({ length: 2_000 }, (_, index) => listingSql.replace("\"products\"", `"products" "p${index}"`));
    let firstParse = 0;
    await withDependencyScope(() => {
      firstParse = nsPerOp(distinct.length / 5, (index) => statementTables(`${distinct[index]!} `));
    }, { log: () => undefined });

    // End to end on node:sqlite through Drizzle's D1 driver: the cheapest real
    // query this repo can run. Hosted D1 reads cost 0.5-5 ms, far above this.
    const query = () => db
      .select({ id: products.id, band: productBuyerState.availabilityBand })
      .from(products)
      .innerJoin(productBuyerState, eq(productBuyerState.productId, products.id))
      .where(eq(products.id, "missing"))
      .all();
    await usPerQuery(500, query); // warm up
    const baseline = await usPerQuery(3_000, query);
    let observed = 0;
    await withDependencyScope(async () => {
      observed = await usPerQuery(3_000, query);
    }, { log: () => undefined });

    console.info([
      `[CacheDeps overhead] SQL ${listingSql.length} chars`,
      `observeStatement, no scope: ${noScope.toFixed(1)} ns/statement`,
      `observeStatement, in scope (memo hit, fresh string): ${inScope.toFixed(1)} ns/statement`,
      `first parse of a new statement shape (memo miss): ${(firstParse / 1_000).toFixed(2)} us`,
      `deps.product(id) in scope: ${declare.toFixed(1)} ns/declaration`,
      `node:sqlite Drizzle query: ${baseline.toFixed(2)} us baseline, ${observed.toFixed(2)} us in scope`,
    ].join("\n  "));

    expect(noScope).toBeLessThan(500);
    expect(inScope).toBeLessThan(5_000);
    expect(declare).toBeLessThan(5_000);
    expect(firstParse).toBeLessThan(200_000);
  }, 60_000);
});
