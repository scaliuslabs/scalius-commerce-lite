// The discount snapshot a storefront checkout carries from its quote to the
// order commit, which re-evaluates it. Types only.
import type { PromotionEvaluationCart, PromotionEvaluationResult } from "./promotions.evaluator";
import type { PresentmentMoney } from "@scalius/shared/presentment";

export type AppliedPromotion = NonNullable<PromotionEvaluationResult["applied"]>;

type CheckoutLine = Omit<PromotionEvaluationCart["lines"][number], "collectionIds">;

export interface StorefrontDiscountCart {
    currencyCode: string;
    /** The store's price increment percentage savings round to (`PricingCurrency`). */
    priceIncrementMinor: number;
    lines: CheckoutLine[];
    shippingAmountMinor: number;
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
