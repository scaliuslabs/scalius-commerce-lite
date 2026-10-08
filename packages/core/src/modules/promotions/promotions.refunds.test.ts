import type { Database } from "@scalius/database/client";
import { describe, expect, it, vi } from "vitest";

import {
    prorateSavedPromotionDiscount,
    readPromotionRefundSnapshot,
} from "./promotions.refunds";

function createDb(
    allocations: Array<Record<string, unknown>>,
    items: Array<Record<string, unknown>>,
    appFacts: Array<Record<string, unknown>> = [],
): Database {
    const allocationQuery = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn(async () => allocations),
    };
    const itemQuery = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn(async () => items),
    };
    // The `app_discount` order facts (order-kernel/app-facts.ts).
    const appFactQuery = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        all: vi.fn(async () => appFacts),
    };
    return {
        select: vi.fn()
            .mockReturnValueOnce(allocationQuery)
            .mockReturnValueOnce(itemQuery)
            .mockReturnValueOnce(appFactQuery),
    } as unknown as Database;
}

describe("promotion refund snapshots", () => {
    it("conserves an indivisible saved discount across partial quantity refunds", () => {
        const first = prorateSavedPromotionDiscount({
            totalDiscountMinor: 100,
            originalQuantity: 3,
            refundedQuantityBefore: 0,
            refundQuantity: 1,
        });
        const second = prorateSavedPromotionDiscount({
            totalDiscountMinor: 100,
            originalQuantity: 3,
            refundedQuantityBefore: 1,
            refundQuantity: 1,
        });
        const final = prorateSavedPromotionDiscount({
            totalDiscountMinor: 100,
            originalQuantity: 3,
            refundedQuantityBefore: 2,
            refundQuantity: 1,
        });

        expect([first, second, final]).toEqual([33, 33, 34]);
        expect(first + second + final).toBe(100);
    });

    it("reconciles immutable line and shipping allocations without re-evaluating rules", async () => {
        const db = createDb([
            {
                id: "allocation_line",
                orderItemId: "item_1",
                target: "order",
                currencyCode: "BDT",
                discountAmountMinor: 80,
            },
            {
                id: "allocation_shipping",
                orderItemId: null,
                target: "shipping",
                currencyCode: "BDT",
                discountAmountMinor: 20,
            },
        ], [{ id: "item_1", discountAmountMinor: 80 }]);

        await expect(readPromotionRefundSnapshot(db, {
            orderId: "order_1",
            currencyCode: "BDT",
            orderDiscountAmountMinor: 100,
        })).resolves.toEqual({
            allocationCount: 2,
            totalDiscountMinor: 100,
            merchandiseDiscountMinor: 80,
            shippingDiscountMinor: 20,
        });
    });

    it("fails closed before refund side effects when snapshots diverge", async () => {
        const db = createDb([{
            id: "allocation_line",
            orderItemId: "item_1",
            target: "line",
            currencyCode: "BDT",
            discountAmountMinor: 70,
        }], [{ id: "item_1", discountAmountMinor: 80 }]);

        await expect(readPromotionRefundSnapshot(db, {
            orderId: "order_1",
            currencyCode: "BDT",
            orderDiscountAmountMinor: 80,
        })).rejects.toThrow("do not reconcile");
    });

    it("reconciles an app discount stacked on the promotion (the rest of each line's saved discount)", async () => {
        const fact = (data: Record<string, unknown>) => ({ orderId: "order_1", kind: "app_discount", createdAt: 1, data: JSON.stringify(data) });
        const db = createDb([{
            id: "allocation_line",
            orderItemId: "item_1",
            target: "line",
            currencyCode: "BDT",
            discountAmountMinor: 70,
        }], [{ id: "item_1", discountAmountMinor: 80 }], [
            fact({ pluginId: "acme.bulk-discount", appName: "Bulk discount", title: "Bulk", code: null, target: "lines", currencyCode: "BDT", amountMinor: 10, shippingAmountMinor: 0, lines: [{ orderItemId: "item_1", amountMinor: 10 }] }),
            fact({ pluginId: "acme.ship", appName: "Ship", title: "Free delivery", code: null, target: "shipping", currencyCode: "BDT", amountMinor: 0, shippingAmountMinor: 30, lines: [] }),
        ]);

        await expect(readPromotionRefundSnapshot(db, {
            orderId: "order_1",
            currencyCode: "BDT",
            orderDiscountAmountMinor: 110,
        })).resolves.toEqual({
            allocationCount: 1,
            totalDiscountMinor: 110,
            merchandiseDiscountMinor: 80,
            shippingDiscountMinor: 30,
        });
    });
});
