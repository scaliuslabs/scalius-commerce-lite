import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

import {
    DEFAULT_ABANDONED_CHECKOUT_CLEANUP_LIMIT,
    cleanupStaleAbandonedCheckouts,
    isAbandonedCheckoutEmpty,
} from "./abandoned-checkout-cleanup";

type CheckoutRow = {
    id: string;
    checkoutData: string;
    customerPhone: string | null;
};

function createDbMock(selectRows: unknown[][]) {
    const selectQueue = [...selectRows];
    const operations: Array<{ op: string; limit?: number }> = [];

    const db = {
        select: vi.fn(() => ({
            from: () => ({
                where: () => ({
                    limit: async (limit: number) => {
                        operations.push({ op: "select.limit", limit });
                        return selectQueue.shift() ?? [];
                    },
                }),
            }),
        })),
        delete: vi.fn(() => ({
            where: async () => {
                operations.push({ op: "delete.where" });
            },
        })),
    };

    return { db: db as unknown as Database, rawDb: db, operations };
}

describe("abandoned checkout cleanup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("detects empty abandoned checkout payloads without deleting rows that still identify a customer", () => {
        expect(isAbandonedCheckoutEmpty({
            checkoutData: JSON.stringify({ items: [], customerInfo: {} }),
            customerPhone: null,
        })).toBe(true);
        expect(isAbandonedCheckoutEmpty({
            checkoutData: "not json",
            customerPhone: null,
        })).toBe(true);
        expect(isAbandonedCheckoutEmpty({
            checkoutData: JSON.stringify({ items: [{ id: "variant_1" }], customerInfo: {} }),
            customerPhone: null,
        })).toBe(false);
        expect(isAbandonedCheckoutEmpty({
            checkoutData: JSON.stringify({ items: [], customerInfo: { name: "Buyer" } }),
            customerPhone: null,
        })).toBe(false);
        expect(isAbandonedCheckoutEmpty({
            checkoutData: "not json",
            customerPhone: "+8801712345678",
        })).toBe(false);
    });

    it("deletes expired checkouts and only empty old checkouts within the same bounded sweep", async () => {
        const expiredRows = [{ id: "expired_1" }, { id: "expired_2" }];
        const oldRows: CheckoutRow[] = [
            { id: "old_empty", checkoutData: JSON.stringify({ items: [], customerInfo: {} }), customerPhone: null },
            { id: "old_cart", checkoutData: JSON.stringify({ items: [{ id: "variant_1" }], customerInfo: {} }), customerPhone: null },
            { id: "old_phone", checkoutData: "not json", customerPhone: "+8801712345678" },
        ];
        const { db, rawDb, operations } = createDbMock([expiredRows, oldRows]);

        const result = await cleanupStaleAbandonedCheckouts(db, 1_765_000_000, { limit: 5 });

        expect(result).toEqual({
            scannedExpired: 2,
            deletedExpired: 2,
            scannedEmpty: 3,
            deletedEmpty: 1,
            limit: 5,
            hasMore: false,
        });
        expect(rawDb.delete).toHaveBeenCalledTimes(2);
        expect(operations).toEqual([
            { op: "select.limit", limit: 6 },
            { op: "delete.where" },
            { op: "select.limit", limit: 4 },
            { op: "delete.where" },
        ]);
    });

    it("bounds each scheduled pass and defers empty-row cleanup while expired rows remain", async () => {
        const { db, rawDb, operations } = createDbMock([
            [{ id: "expired_1" }, { id: "expired_2" }, { id: "expired_3" }],
        ]);

        const result = await cleanupStaleAbandonedCheckouts(db, 1_765_000_000, { limit: 2 });

        expect(result).toMatchObject({
            scannedExpired: 2,
            deletedExpired: 2,
            scannedEmpty: 0,
            deletedEmpty: 0,
            limit: 2,
            hasMore: true,
        });
        expect(rawDb.select).toHaveBeenCalledTimes(1);
        expect(rawDb.delete).toHaveBeenCalledTimes(1);
        expect(operations).toEqual([
            { op: "select.limit", limit: 3 },
            { op: "delete.where" },
        ]);
    });

    it("uses conservative defaults when options are omitted or invalid", async () => {
        const { db, operations } = createDbMock([[], []]);

        const result = await cleanupStaleAbandonedCheckouts(db, 1_765_000_000, {
            limit: Number.NaN,
            retentionDays: Number.NaN,
            emptyMaxAgeMinutes: Number.NaN,
        });

        expect(result).toMatchObject({
            limit: DEFAULT_ABANDONED_CHECKOUT_CLEANUP_LIMIT,
            hasMore: false,
        });
        expect(operations).toEqual([
            { op: "select.limit", limit: DEFAULT_ABANDONED_CHECKOUT_CLEANUP_LIMIT + 1 },
            { op: "select.limit", limit: DEFAULT_ABANDONED_CHECKOUT_CLEANUP_LIMIT + 1 },
        ]);
    });
});
