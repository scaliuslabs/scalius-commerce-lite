import type { Database } from "@scalius/database/client";
import { describe, expect, it, vi } from "vitest";

import {
    prorateSavedPromotionDiscount,
    readPromotionRefundSnapshot,
} from "./promotions.refunds";

function createDb(
    allocations: Array<Record<string, unknown>>,
    items: Array<Record<string, unknown>>,
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
    return {
        select: vi.fn()
            .mockReturnValueOnce(allocationQuery)
            .mockReturnValueOnce(itemQuery),
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
});
