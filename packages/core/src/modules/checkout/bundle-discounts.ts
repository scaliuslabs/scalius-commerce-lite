// How quantity bundles and promotions combine at checkout. One rule for the
// tax quote the buyer reviews, the order checkout commits and the agent quote:
//
// 1. Promotions (automatic ones and codes) are evaluated on the catalog line
//    prices, as if no bundle existed. A bundle never changes which promotion
//    applies or its amount: minimum spends, Buy X get Y and the promotion
//    snapshot commit re-verifies all see the same cart.
// 2. Each line's bundle saving (cart validation, from the catalog prices)
//    then adds to that line's promotion discount, capped at what the
//    promotion leaves of the line: a line never goes below zero, and the
//    bundle yields, never the promotion.
// 3. Delivery thresholds ("free over") read the catalog subtotal, as they do
//    with promotions.
//
// So a 10% code on a line that also reached "2 for 10% off" takes 10% + 10%
// of the catalog price, and a free item from Buy X get Y keeps no bundle
// saving. Amounts are integer minor units; with BDT's whole-taka catalog
// prices every bundle share is whole taka.
import type { TaxDiscountAllocationInput } from "../tax/types";

export interface BundleDiscountLine {
    /** The tax allocation line id (`buildStorefrontTaxAllocationLineId`). */
    lineId: string;
    unitPriceMinor: number;
    quantity: number;
    /** The line's bundle saving from cart validation (0 when none). */
    bundleDiscountMinor: number;
}

export interface BundleDiscountResult {
    /** Promotion plus bundle, per line; the promotion's own when no bundle applies. */
    allocation: TaxDiscountAllocationInput | undefined;
    /** The bundle part that applied, per line with a saving. */
    bundleLines: Array<{ lineId: string; amountMinor: number }>;
    bundleDiscountMinor: number;
}

export function applyBundleSavingsToDiscountAllocation(
    lines: readonly BundleDiscountLine[],
    promotionAllocation: TaxDiscountAllocationInput | undefined,
): BundleDiscountResult {
    const promotionByLine = new Map((promotionAllocation?.lines ?? []).map((line) => [line.lineId, line.amountMinor]));
    const bundleLines: Array<{ lineId: string; amountMinor: number }> = [];
    for (const line of lines) {
        const saving = line.bundleDiscountMinor;
        if (!Number.isSafeInteger(saving) || saving < 0) throw new RangeError("Bundle savings are non-negative integer minor units.");
        if (saving === 0) continue;
        const grossMinor = line.unitPriceMinor * line.quantity;
        const left = Math.max(0, grossMinor - (promotionByLine.get(line.lineId) ?? 0));
        const amountMinor = Math.min(saving, left);
        if (amountMinor > 0) bundleLines.push({ lineId: line.lineId, amountMinor });
    }
    if (bundleLines.length === 0) {
        return { allocation: promotionAllocation, bundleLines, bundleDiscountMinor: 0 };
    }
    const bundleByLine = new Map(bundleLines.map((line) => [line.lineId, line.amountMinor]));
    return {
        allocation: {
            lines: lines
                .map((line) => ({
                    lineId: line.lineId,
                    amountMinor: (promotionByLine.get(line.lineId) ?? 0) + (bundleByLine.get(line.lineId) ?? 0),
                }))
                .filter((line) => line.amountMinor > 0),
            shippingMinor: promotionAllocation?.shippingMinor ?? 0,
        },
        bundleLines,
        bundleDiscountMinor: bundleLines.reduce((sum, line) => sum + line.amountMinor, 0),
    };
}
