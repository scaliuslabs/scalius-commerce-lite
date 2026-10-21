// The bounded listing plans on PostgreSQL (scenarios in listing-scale.fixture.ts).
// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { CORRELATED_SUBQUERY_FILTER, LISTING_SCALE_ROWS, listingScaleScenarios, listingScaleSeed, type ListingScaleRow } from "./listing-scale.fixture";
import { subtreePageIds } from "./listing";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("bounded listing plans on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    const setup = async () => {
        const { db, client } = await createNativePostgres({ label: "listing_scale" });
        await client.query(listingScaleSeed());
        await rebuildCatalogProjections(db, { limit: 2_700 });
        const rows = (await client.query(LISTING_SCALE_ROWS)).rows as ListingScaleRow[];
        const subtreePrices = (await client.query(`SELECT MIN(from_minor) AS min, MAX(to_minor) AS max FROM product_buyer_state
            WHERE is_public = 1 AND category_id IN ('cat_root', 'cat_a', 'cat_b', 'cat_c')`)).rows[0] as { min: number; max: number };
        return { db, rows, subtreePrices: { min: Number(subtreePrices.min), max: Number(subtreePrices.max) } };
    };
    listingScaleScenarios(setup);

    // The 2026-10-21 scale proof: a correlated `IN (… LIMIT n)` per category
    // walked all 50,000 buyer-state rows and ran its subquery 100,000 times
    // (53,707 tuples, 347 ms for a 42-product category).
    it.each(["newest", "price-asc", "price-desc"] as const)("pages a subtree by %s without a correlated subquery filter", async (sort) => {
        const { db } = await setup();
        const plan = (await db.all<Record<string, string> | string[]>(sql`EXPLAIN ${subtreePageIds({
            categoryIds: sql`(SELECT descendant_id FROM category_closure WHERE ancestor_id = ${"cat_root"})`,
            conditions: [sql`"product_buyer_state"."is_public" = 1`],
            cursor: undefined,
            sort,
            perCategory: 21,
            limit: 21,
            offset: 0,
            needsProducts: false,
        })}`)).map((row) => String(Array.isArray(row) ? row[0] : Object.values(row)[0])).join("\n");
        expect(plan).not.toMatch(CORRELATED_SUBQUERY_FILTER);
        expect(plan).toContain("json_each");
    });
});
