// A market priced by its lists orders, filters and bounds its listings by its own card prices, on
// PostgreSQL (scenarios in market-price-order.fixture.ts). Opt-in: SCALIUS_TEST_POSTGRES_URL.
import { afterAll, beforeAll, describe, vi } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { marketPriceOrderScenarios, marketPriceOrderSeed } from "./market-price-order.fixture";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("market price order on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    const clock = { now: 0 };
    beforeAll(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(clock.now * 1000);
    });
    afterAll(() => vi.useRealTimers());
    marketPriceOrderScenarios(async () => {
        const { db, client } = await createNativePostgres({ label: "market_price_order" });
        await client.query(marketPriceOrderSeed());
        await rebuildCatalogProjections(db, { limit: 2_700 });
        return { db };
    }, clock);
});
