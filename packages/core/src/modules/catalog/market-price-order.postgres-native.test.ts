// A market priced by its lists orders, filters and bounds its listings by its own card prices, on
// PostgreSQL (scenarios in market-price-order.fixture.ts). Opt-in: SCALIUS_TEST_POSTGRES_URL.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { readMarketPriceContext } from "../price-lists";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { CORRELATED_SUBQUERY_FILTER } from "./listing-scale.fixture";
import { listStreamSql } from "./market-price-order";
import { marketPriceOrderScenarios, marketPriceOrderSeed } from "./market-price-order.fixture";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("market price order on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    const clock = { now: 0 };
    beforeAll(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(clock.now * 1000);
    });
    afterAll(() => vi.useRealTimers());
    const setup = async () => {
        const { db, client } = await createNativePostgres({ label: "market_price_order" });
        await client.query(marketPriceOrderSeed());
        await rebuildCatalogProjections(db, { limit: 2_700 });
        return { db };
    };
    marketPriceOrderScenarios(setup, clock);

    // Each live list's first rows as one JSON list, never a correlated
    // `IN (… LIMIT n)` filter run once per list price row.
    it.each(["asc", "desc"] as const)("reads the list stream %s without a correlated subquery filter", async (direction) => {
        const { db } = await setup();
        const context = await readMarketPriceContext(db, "en-in", clock.now);
        const plan = (await db.all<Record<string, string> | string[]>(sql`EXPLAIN ${listStreamSql(context, {
            conditions: [sql`"product_buyer_state"."is_public" = 1`],
            needsProducts: false,
            key: "from",
            direction,
            needed: 21,
        }, 21)}`)).map((row) => String(Array.isArray(row) ? row[0] : Object.values(row)[0])).join("\n");
        expect(plan).not.toMatch(CORRELATED_SUBQUERY_FILTER);
        expect(plan).toContain("json_each");
    });
});
