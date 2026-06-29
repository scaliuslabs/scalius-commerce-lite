import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

import { getRecentOrders } from "./dashboard.service";

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
});
