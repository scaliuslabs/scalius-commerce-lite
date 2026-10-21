// The bounded listing plans on D1 (scenarios in listing-scale.fixture.ts).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { LISTING_SCALE_ROWS, listingScaleScenarios, listingScaleSeed, type ListingScaleRow } from "./listing-scale.fixture";

let sqlite: DatabaseSync | null = null;
afterEach(() => {
    sqlite?.close();
    sqlite = null;
});

describe("bounded listing plans on D1", () => {
    listingScaleScenarios(async () => {
        const harness = createSqliteD1Database();
        sqlite = harness.sqlite;
        sqlite.exec(listingScaleSeed());
        await rebuildCatalogProjections(harness.db, { limit: 2_700 });
        const rows = sqlite.prepare(LISTING_SCALE_ROWS).all() as unknown as ListingScaleRow[];
        const subtreePrices = sqlite.prepare(`SELECT MIN(from_minor) AS min, MAX(to_minor) AS max FROM product_buyer_state
            WHERE is_public = 1 AND category_id IN ('cat_root', 'cat_a', 'cat_b', 'cat_c')`).get() as { min: number; max: number };
        return { db: harness.db, rows, subtreePrices };
    });
});
