import { allocateMinorAmount, toMinorUnits } from "./money";
import type { TaxDiscountAllocationInput } from "./types";

export interface StorefrontDiscountAllocationLine {
    lineId: string;
    unitPrice: number;
    quantity: number;
}

/**
 * Stable identity used only for tax/discount allocation. Order-item primary
 * keys stay random, while quote and create retries use the same tie-break key.
 */
export function buildStorefrontTaxAllocationLineId(index: number, variantId: string): string {
    if (!Number.isInteger(index) || index < 0 || index > 98) {
        throw new RangeError("Tax allocation line index is invalid.");
    }
    const normalizedVariantId = variantId.trim();
    if (!normalizedVariantId || normalizedVariantId === "default") {
        throw new RangeError("Tax allocation requires a persisted variant id.");
    }
    return `cart:${index}:${normalizedVariantId}`;
}

/**
 * Spreads a manual order-level discount (admin orders) across the lines by
 * value. Storefront discounts come with their exact promotion allocation.
 */
export function buildStorefrontDiscountAllocation(input: {
    decimalPlaces: number;
    discountAmount: number;
    lines: StorefrontDiscountAllocationLine[];
}): { discountMinor: number; allocation: TaxDiscountAllocationInput } {
    const requestedMinor = toMinorUnits(input.discountAmount, input.decimalPlaces);
    const weights = input.lines.map((line) => {
        const weightMinor = toMinorUnits(line.unitPrice, input.decimalPlaces) * line.quantity;
        if (!Number.isSafeInteger(weightMinor) || weightMinor < 0) {
            throw new RangeError("Discount allocation line total exceeds the safe integer range.");
        }
        return { key: line.lineId, weightMinor };
    });
    const grossMinor = weights.reduce((sum, line) => sum + line.weightMinor, 0);
    if (!Number.isSafeInteger(grossMinor)) {
        throw new RangeError("Discount allocation total exceeds the safe integer range.");
    }
    const discountMinor = Math.min(requestedMinor, grossMinor);
    if (discountMinor === 0) return { discountMinor: 0, allocation: { lines: [], shippingMinor: 0 } };
    const allocated = allocateMinorAmount(discountMinor, weights);
    return {
        discountMinor,
        allocation: {
            lines: input.lines.map((line) => ({
                lineId: line.lineId,
                amountMinor: allocated.get(line.lineId) ?? 0,
            })),
            shippingMinor: 0,
        },
    };
}
