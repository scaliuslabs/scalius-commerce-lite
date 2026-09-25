// How quantity bundles and promotions combine at checkout. One rule for the
// tax quote the buyer reviews, the order checkout commits and the agent quote:
//
// An order is priced either by its promotions or by its bundles, never both.
//
// 1. Promotions (automatic ones and codes) are evaluated first, on the catalog
//    line prices, exactly as without bundles.
// 2. The buyer gets whichever saves more in total: the promotions (automatic
//    ones and typed codes together), or the bundle savings (cart validation,
//    from the catalog prices, each capped at its line). A tie keeps the
//    promotions. A typed code that loses is never silently dropped: it stays
//    on the order's code list as `lower_savings` with `bundleSavesMore`,
//    so every summary says "Bundle saving applied: better than CODE".
// 3. Delivery thresholds ("free over") read the catalog subtotal either way.
//
// Why not both: an order's line discounts must equal its promotion
// allocations (the commit check, refund reconciliation and receipt lines all
// read `order_discount_allocations`), and a bundle saving has no allocation
// row. Stacking needs a recorded bundle part per line: a lead-numbered
// migration, after which only `resolveBundlePromotionInterplay` changes.
//
// Amounts are integer minor units; with BDT's whole-taka catalog prices every
// bundle share is whole taka.
import type { RejectedDiscountCode, StorefrontDiscountQuote } from "../promotions/promotions.checkout";

/** How a typed code that the bundle saving beat is named to the buyer. */
export const BUNDLE_SAVING_NAME = "Bundle saving";
import type { TaxDiscountAllocationInput } from "../tax/types";

export interface BundleDiscountLine {
    /** The tax allocation line id (`buildStorefrontTaxAllocationLineId`). */
    lineId: string;
    unitPriceMinor: number;
    quantity: number;
    /** The line's bundle saving from cart validation (0 when none). */
    bundleDiscountMinor: number;
}

export interface BundlePromotionInterplay {
    /** The promotions that price the order (none when the bundles won). */
    discount: StorefrontDiscountQuote;
    /** The line discounts the tax quote allocates. */
    allocation: TaxDiscountAllocationInput | undefined;
    /** The bundle savings that apply, per line; empty when the promotions won. */
    bundleLines: Array<{ lineId: string; amountMinor: number }>;
    bundleDiscountMinor: number;
}

export function resolveBundlePromotionInterplay(
    lines: readonly BundleDiscountLine[],
    discount: StorefrontDiscountQuote,
): BundlePromotionInterplay {
    const bundleLines: Array<{ lineId: string; amountMinor: number }> = [];
    for (const line of lines) {
        const saving = line.bundleDiscountMinor;
        if (!Number.isSafeInteger(saving) || saving < 0) throw new RangeError("Bundle savings are non-negative integer minor units.");
        const amountMinor = Math.min(saving, line.unitPriceMinor * line.quantity);
        if (amountMinor > 0) bundleLines.push({ lineId: line.lineId, amountMinor });
    }
    const bundleDiscountMinor = bundleLines.reduce((sum, line) => sum + line.amountMinor, 0);
    const promotionsWin = { discount, allocation: discount.taxAllocation, bundleLines: [], bundleDiscountMinor: 0 };
    if (bundleDiscountMinor === 0) return promotionsWin;
    const applied = discount.applied;
    if (applied && applied.totalDiscountMinor >= bundleDiscountMinor) return promotionsWin;
    // The promotions step aside; offers and code feedback stay, and each typed
    // code that applied says the bundle saving beat it.
    const beatenCodes: RejectedDiscountCode[] = [...new Set(
        (applied?.discounts ?? []).flatMap((each) => each.promotionCode ? [each.promotionCode] : []),
    )].map((code) => ({
        code,
        reason: "lower_savings",
        conflictsWith: BUNDLE_SAVING_NAME,
        bundleSavesMore: true,
        message: `${BUNDLE_SAVING_NAME} applied: better than ${code}.`,
    }));
    return {
        discount: {
            ...discount,
            applied: null,
            snapshot: null,
            taxAllocation: undefined,
            discounts: [],
            rejectedCodes: [...discount.rejectedCodes, ...beatenCodes],
        },
        allocation: { lines: bundleLines, shippingMinor: 0 },
        bundleLines,
        bundleDiscountMinor,
    };
}
