import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

import { getDashboardHomeSummary, getRecentOrders } from "./dashboard.service";

function createRecentOrdersDb(rows: unknown[]) {
    const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve(rows).then(resolve, reject),
    };
    return {
        db: { select: vi.fn(() => chain) } as unknown as Database,
        chain,
    };
}

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

    it("logs a generic timing label for dashboard reads", async () => {
        const { db, chain } = createRecentOrdersDb([
            {
                id: "ord_1",
                customerName: "Buyer",
                totalAmount: 1200,
                status: "processing",
                createdAt: "2026-06-28T06:00:00.000Z",
            },
        ]);

        const result = await getRecentOrders(db, 3);

        expect(chain.limit).toHaveBeenCalledWith(3);
        expect(chain.where).toHaveBeenCalledOnce();
        expect(result).toEqual([
            {
                id: "ord_1",
                customerName: "Buyer",
                totalAmount: 1200,
                status: "processing",
                createdAt: new Date("2026-06-28T06:00:00.000Z"),
            },
        ]);
        expect(console.log).toHaveBeenCalledWith("[dashboard-query]", expect.objectContaining({
            event: "dashboard_query_completed",
            query: "recent_orders",
            attempts: 1,
            durationMs: expect.any(Number),
        }));
        expect(console.warn).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it("loads dashboard home metrics and recent orders in one provider batch", async () => {
        const { db, batch, chains } = createDashboardHomeDb([
            [{ count: 12 }],
            [{ count: 34 }],
            [{ count: 9, revenue: 1234, delivered: 3, processing: 4, shipping: 1, cancelled: 1 }],
            [{ count: 8, revenue: 1000 }],
            [{
                id: "ord_1",
                customerName: "Buyer",
                totalAmount: 1200,
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
                    orderGrowth: 13,
                    revenueGrowth: 23,
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
});
