// The discount snapshot a storefront checkout carries from its quote to the
// order commit, which re-evaluates it. Types only.
import type { PromotionEvaluationCart, PromotionEvaluationResult } from "./promotions.evaluator";

export type AppliedPromotion = NonNullable<PromotionEvaluationResult["applied"]>;

type CheckoutLine = Omit<PromotionEvaluationCart["lines"][number], "collectionIds">;

export interface StorefrontDiscountCart {
    currencyCode: string;
    lines: CheckoutLine[];
    shippingAmountMinor: number;
}

/** What the order commit re-evaluates; present only when a discount applies. */
export interface PromotionCheckoutSnapshot {
    cart: StorefrontDiscountCart & { submittedCodes: string[] };
    applied: AppliedPromotion;
}
