// The discount snapshot a storefront checkout carries from its quote to the
// order commit, which re-evaluates it. Types only.
import type { PromotionEvaluationCart, PromotionEvaluationResult } from "./promotions.evaluator";
import type { PresentmentMoney } from "@scalius/shared/presentment";

export type AppliedPromotion = NonNullable<PromotionEvaluationResult["applied"]>;

/**
 * The item a line is priced as part of (a kit's component line: the kit):
 * promotions judge the item, never the line's own product. Lines naming one
 * `id` are evaluated as that one item (its product and SKU, its `quantity`,
 * their summed price), and a discount on it lands on them in proportion to
 * their prices (`splitPricedAsAllocations`).
 */
export interface PricedAsIdentity {
    id: string;
    productId: string;
    variantId: string;
    quantity: number;
}

type CheckoutLine = Omit<PromotionEvaluationCart["lines"][number], "collectionIds"> & { pricedAs?: PricedAsIdentity };

export interface StorefrontDiscountCart {
    currencyCode: string;
    /** The store's price increment percentage savings round to (`PricingCurrency`). */
    priceIncrementMinor: number;
    lines: CheckoutLine[];
    shippingAmountMinor: number;
    /** Each shipping profile's part of `shippingAmountMinor`; a free shipping discount can exclude profiles. */
    shippingShares?: PromotionEvaluationCart["shippingShares"];
    /**
     * A cart in a market's own currency (MARKETS-DESIGN step 6): a promotion's
     * shop-currency amounts (fixed amounts off, minimum subtotals, buy
     * amounts) convert at this locked rate and round to its increment.
     * Absent: the shop currency.
     */
    money?: PresentmentMoney;
}

/** What the order commit re-evaluates; present only when a discount applies. */
export interface PromotionCheckoutSnapshot {
    cart: StorefrontDiscountCart & { submittedCodes: string[] };
    applied: AppliedPromotion;
}
