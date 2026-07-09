import { allocateMinorAmount, toMinorUnits } from "./money";
import type { TaxDiscountAllocationInput } from "./types";

export type StorefrontDiscountType =
    | "amount_off_products"
    | "amount_off_order"
    | "free_shipping";

export interface StorefrontDiscountAllocationLine {
    lineId: string;
    productId: string;
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

export function buildStorefrontDiscountAllocation(input: {
    decimalPlaces: number;
    discountAmount: number;
    discountType: StorefrontDiscountType | null;
    applicableProductIds?: readonly string[];
    lines: StorefrontDiscountAllocationLine[];
    shippingAmount: number;
}): { discountMinor: number; allocation: TaxDiscountAllocationInput } {
    const requestedMinor = toMinorUnits(input.discountAmount, input.decimalPlaces);
    const shippingGrossMinor = toMinorUnits(input.shippingAmount, input.decimalPlaces);
    if (!input.discountType) {
        if (requestedMinor !== 0) throw new RangeError("A validated discount type is required.");
        return { discountMinor: 0, allocation: { lines: [], shippingMinor: 0 } };
    }
    if (!(["amount_off_products", "amount_off_order", "free_shipping"] as const).includes(input.discountType)) {
        throw new RangeError("The validated discount type is unsupported.");
    }

    if (input.discountType === "free_shipping") {
        const shippingMinor = Math.min(requestedMinor, shippingGrossMinor);
        return { discountMinor: shippingMinor, allocation: { lines: [], shippingMinor } };
    }

    const applicableIds = new Set(input.applicableProductIds ?? []);
    const eligibleLines = input.lines.filter((line) =>
        input.discountType === "amount_off_order" ||
        applicableIds.size === 0 ||
        applicableIds.has(line.productId),
    );
    const weights = eligibleLines.map((line) => {
        const weightMinor = toMinorUnits(line.unitPrice, input.decimalPlaces) * line.quantity;
        if (!Number.isSafeInteger(weightMinor) || weightMinor < 0) {
            throw new RangeError("Discount allocation line total exceeds the safe integer range.");
        }
        return { key: line.lineId, weightMinor };
    });
    const eligibleGrossMinor = weights.reduce((sum, line) => sum + line.weightMinor, 0);
    if (!Number.isSafeInteger(eligibleGrossMinor)) {
        throw new RangeError("Discount allocation total exceeds the safe integer range.");
    }
    const discountMinor = Math.min(requestedMinor, eligibleGrossMinor);
    const allocated = allocateMinorAmount(discountMinor, weights);
    return {
        discountMinor,
        allocation: {
            lines: eligibleLines.map((line) => ({
                lineId: line.lineId,
                amountMinor: allocated.get(line.lineId) ?? 0,
            })),
            shippingMinor: 0,
        },
    };
}
