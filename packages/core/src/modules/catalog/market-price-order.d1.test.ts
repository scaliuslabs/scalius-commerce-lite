// A market priced by its lists orders, filters and bounds its listings by its own card prices, on D1
// (scenarios in market-price-order.fixture.ts).
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { marketPriceOrderScenarios, marketPriceOrderSeed } from "./market-price-order.fixture";

let sqlite: DatabaseSync | null = null;
afterEach(() => {
    sqlite?.close();
    sqlite = null;
});

describe("market price order on D1", () => {
    const clock = { now: 0 };
    beforeAll(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(clock.now * 1000);
    });
    afterAll(() => vi.useRealTimers());
    marketPriceOrderScenarios(async () => {
        const harness = createSqliteD1Database();
        sqlite = harness.sqlite;
        sqlite.exec(marketPriceOrderSeed());
        await rebuildCatalogProjections(harness.db, { limit: 2_700 });
        return { db: harness.db };
    }, clock);
});
