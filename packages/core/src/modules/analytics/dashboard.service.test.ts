import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

import { getDashboardHomeSummary } from "./dashboard.service";

function createDashboardHomeDb(batchRows: unknown[]) {
    const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
    const select = vi.fn(() => {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chains.push(chain);
        return chain;
    });
    const batch = vi.fn().mockResolvedValue(batchRows);
    return {
        db: { select, batch } as unknown as Database,
        batch,
        chains,
    };
}

describe("dashboard query observability", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("loads dashboard home metrics and recent orders in one provider batch", async () => {
        const { db, batch, chains } = createDashboardHomeDb([
            [{ count: 12 }],
            [{ count: 34 }],
            [{ count: 9, revenueMinor: 123_400, currencyDecimalPlaces: 2, delivered: 3, processing: 4, shipping: 1, cancelled: 1 }],
            [{ count: 8, revenueMinor: 100_000, currencyDecimalPlaces: 2 }],
            [{
                id: "ord_1",
                customerName: "Buyer",
                totalAmountMinor: 120_000,
                currencyDecimalPlaces: 2,
                status: "processing",
                createdAt: "2026-06-28T06:00:00.000Z",
            }],
        ]);

        const result = await getDashboardHomeSummary(db, 11);

        expect(batch).toHaveBeenCalledOnce();
        expect(batch.mock.calls[0]?.[0]).toHaveLength(5);
        expect(chains).toHaveLength(5);
        expect(chains[4]?.limit).toHaveBeenCalledWith(11);
        expect(result).toEqual({
            stats: {
                totalProducts: 12,
                totalCustomers: 34,
                currentMonth: {
                    orders: 9,
                    revenue: 1234,
                    orderGrowth: 12.5,
                    revenueGrowth: expect.closeTo(23.4, 8),
                    orderStatus: {
                        delivered: 3,
                        processing: 4,
                        shipping: 1,
                        cancelled: 1,
                    },
                },
                lastMonth: { orders: 8, revenue: 1000 },
            },
            recentOrders: [{
                id: "ord_1",
                customerName: "Buyer",
                totalAmount: 1200,
                status: "processing",
                createdAt: new Date("2026-06-28T06:00:00.000Z"),
            }],
        });
        expect(console.log).toHaveBeenCalledWith("[dashboard-query]", expect.objectContaining({
            event: "dashboard_query_completed",
            query: "home_summary",
            attempts: 1,
            durationMs: expect.any(Number),
        }));
    });

    it("skips the recent-order feed when none is requested", async () => {
        const { db, batch } = createDashboardHomeDb([
            [{ count: 1 }],
            [{ count: 2 }],
            [{ count: 0, revenueMinor: null, currencyDecimalPlaces: 2, delivered: 0, processing: 0, shipping: 0, cancelled: 0 }],
            [{ count: 0, revenueMinor: null, currencyDecimalPlaces: 2 }],
        ]);

        const result = await getDashboardHomeSummary(db, 0);

        expect(batch.mock.calls[0]?.[0]).toHaveLength(4);
        expect(result.recentOrders).toEqual([]);
    });
});
