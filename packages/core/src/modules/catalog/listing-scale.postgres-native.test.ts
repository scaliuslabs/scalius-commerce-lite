// The bounded listing plans on PostgreSQL (scenarios in listing-scale.fixture.ts).
// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
import { afterAll, describe } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { LISTING_SCALE_ROWS, listingScaleScenarios, listingScaleSeed, type ListingScaleRow } from "./listing-scale.fixture";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("bounded listing plans on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    listingScaleScenarios(async () => {
        const { db, client } = await createNativePostgres({ label: "listing_scale" });
        await client.query(listingScaleSeed());
        await rebuildCatalogProjections(db, { limit: 2_700 });
        const rows = (await client.query(LISTING_SCALE_ROWS)).rows as ListingScaleRow[];
        const subtreePrices = (await client.query(`SELECT MIN(from_minor) AS min, MAX(to_minor) AS max FROM product_buyer_state
            WHERE is_public = 1 AND category_id IN ('cat_root', 'cat_a', 'cat_b', 'cat_c')`)).rows[0] as { min: number; max: number };
        return { db, rows, subtreePrices: { min: Number(subtreePrices.min), max: Number(subtreePrices.max) } };
    });
});
