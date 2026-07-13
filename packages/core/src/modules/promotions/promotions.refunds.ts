import type { Database } from "@scalius/database/client";
import { orderDiscountAllocations, orderItems } from "@scalius/database/schema";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { asc, eq } from "drizzle-orm";

export interface PromotionRefundSnapshot {
    allocationCount: number;
    totalDiscountMinor: number;
    merchandiseDiscountMinor: number;
    shippingDiscountMinor: number;
}

/**
 * Allocates a saved line discount across quantity refunds without losing or
 * inventing minor units. Each call returns the delta between two cumulative
 * floors, so refunding every unit in any positive chunk sizes conserves the
 * exact immutable allocation. Item-aware refund commands are not exposed yet;
 * this is the calculation boundary they must use when they are introduced.
 */
export function prorateSavedPromotionDiscount(input: {
    totalDiscountMinor: number;
    originalQuantity: number;
    refundedQuantityBefore: number;
    refundQuantity: number;
}): number {
    const {
        totalDiscountMinor,
        originalQuantity,
        refundedQuantityBefore,
        refundQuantity,
    } = input;
    if (
        !Number.isSafeInteger(totalDiscountMinor)
        || totalDiscountMinor < 0
        || !Number.isSafeInteger(originalQuantity)
        || originalQuantity < 1
        || !Number.isSafeInteger(refundedQuantityBefore)
        || refundedQuantityBefore < 0
        || !Number.isSafeInteger(refundQuantity)
        || refundQuantity < 1
        || refundedQuantityBefore + refundQuantity > originalQuantity
    ) {
        throw new RangeError("Saved promotion refund quantities are invalid.");
    }
    const total = BigInt(totalDiscountMinor);
    const quantity = BigInt(originalQuantity);
    const before = BigInt(refundedQuantityBefore);
    const after = BigInt(refundedQuantityBefore + refundQuantity);
    return Number((total * after) / quantity - (total * before) / quantity);
}

/**
 * Validates the immutable promotion allocation ledger against the immutable
 * order-item discount snapshot before refund math or provider side effects.
 * Orders created by the legacy discount authority have no allocation rows and
 * remain on their explicit saved-total compatibility path.
 */
export async function readPromotionRefundSnapshot(
    db: Database,
    input: {
        orderId: string;
        currencyCode: string;
        orderDiscountAmountMinor: number;
    },
): Promise<PromotionRefundSnapshot | null> {
    const allocations = await db.select({
        id: orderDiscountAllocations.id,
        orderItemId: orderDiscountAllocations.orderItemId,
        target: orderDiscountAllocations.target,
        currencyCode: orderDiscountAllocations.currencyCode,
        discountAmountMinor: orderDiscountAllocations.discountAmountMinor,
    }).from(orderDiscountAllocations)
        .where(eq(orderDiscountAllocations.orderId, input.orderId))
        .orderBy(asc(orderDiscountAllocations.id));
    if (allocations.length === 0) return null;

    const items = await db.select({
        id: orderItems.id,
        discountAmountMinor: orderItems.discountAmountMinor,
    }).from(orderItems).where(eq(orderItems.orderId, input.orderId));
    const savedLineDiscounts = new Map(items.map((item) => [
        item.id,
        item.discountAmountMinor ?? 0,
    ]));
    const allocatedByItem = new Map<string, number>();
    let merchandiseDiscountMinor = 0;
    let shippingDiscountMinor = 0;
    for (const allocation of allocations) {
        if (allocation.currencyCode !== input.currencyCode) {
            throw new ServiceUnavailableError("The saved promotion refund currency is inconsistent. Repair the order before refunding it.");
        }
        if (allocation.target === "shipping") {
            if (allocation.orderItemId !== null) {
                throw new ServiceUnavailableError("The saved shipping promotion allocation is inconsistent.");
            }
            shippingDiscountMinor += allocation.discountAmountMinor;
            continue;
        }
        if (!allocation.orderItemId || !savedLineDiscounts.has(allocation.orderItemId)) {
            throw new ServiceUnavailableError("A saved promotion refund allocation is missing its order item.");
        }
        merchandiseDiscountMinor += allocation.discountAmountMinor;
        allocatedByItem.set(
            allocation.orderItemId,
            (allocatedByItem.get(allocation.orderItemId) ?? 0) + allocation.discountAmountMinor,
        );
    }
    for (const [itemId, savedDiscountMinor] of savedLineDiscounts) {
        if ((allocatedByItem.get(itemId) ?? 0) !== savedDiscountMinor) {
            throw new ServiceUnavailableError("The saved promotion and order-item refund allocations do not reconcile.");
        }
    }
    const totalDiscountMinor = merchandiseDiscountMinor + shippingDiscountMinor;
    if (totalDiscountMinor !== input.orderDiscountAmountMinor) {
        throw new ServiceUnavailableError("The saved promotion and order refund totals do not reconcile.");
    }
    return {
        allocationCount: allocations.length,
        totalDiscountMinor,
        merchandiseDiscountMinor,
        shippingDiscountMinor,
    };
}
