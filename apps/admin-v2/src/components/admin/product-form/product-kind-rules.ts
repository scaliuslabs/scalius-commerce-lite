// What kind of product this is decides which parts of the editor apply
// (Wave B §4.2, §9.1). One pure function answers it; the cards read the
// answer instead of checking `isGiftCard` or the fulfilment kind themselves.
import { createContext, useContext } from "react";
import type { ProductFulfilmentMode } from "./fulfilment-mode";

export interface ProductKindRules {
  /** Every variant is a denomination, sold as a code (Products › Gift cards). */
  giftCard: boolean;
  /** Free delivery: nothing ships for a gift card. */
  showShipping: boolean;
  /** Package weight: never for a gift card or a service. */
  showWeight: boolean;
  /** Product and variant discounts: a gift card is worth its price, so it is never discounted. */
  showDiscount: boolean;
  /** Track quantity, quantities and bulk quantity edits: gift cards are untracked. */
  showInventory: boolean;
  /** The fulfilment kind every SKU must have, or null when the merchant chooses (the Fulfilment select). */
  forcedFulfillmentKind: "digital" | null;
}

export function productKindRules(values: {
  isGiftCard?: boolean | null;
  fulfillmentKind?: ProductFulfilmentMode | null;
}): ProductKindRules {
  const giftCard = values.isGiftCard === true;
  const kind = giftCard ? "digital" : values.fulfillmentKind ?? "physical";
  return {
    giftCard,
    showShipping: !giftCard,
    showWeight: !giftCard && kind !== "service",
    showDiscount: !giftCard,
    showInventory: !giftCard,
    forcedFulfillmentKind: giftCard ? "digital" : null,
  };
}

/** A physical product with nothing hidden: what the editor shows without a provider. */
export const DEFAULT_PRODUCT_KIND_RULES: ProductKindRules = productKindRules({});

type ConstrainableSku = {
  trackInventory: boolean;
  stock?: number;
  discountType?: "percentage" | "flat";
  discountPercentage?: number | null;
  discountAmount?: number | null;
  fulfillmentKind?: "physical" | "digital" | "service";
};

/**
 * A SKU as the kind allows it to be saved: a gift card's SKU is untracked,
 * undiscounted and digital (the API refuses anything else). `keepStock` keeps
 * a saved SKU's recorded quantity so a save never writes stock; new rows start
 * at 0. Returns the same object when nothing changes, so memoised rows keep
 * their identity.
 */
export function constrainSkuForKind<T extends ConstrainableSku>(sku: T, rules: ProductKindRules, keepStock = false): T {
  const patch: Partial<ConstrainableSku> = {};
  if (!rules.showInventory) {
    if (sku.trackInventory) patch.trackInventory = false;
    if (!keepStock && sku.stock !== undefined && sku.stock !== 0) patch.stock = 0;
  }
  if (!rules.showDiscount) {
    if (sku.discountType !== undefined && sku.discountType !== "percentage") patch.discountType = "percentage";
    if (sku.discountPercentage) patch.discountPercentage = null;
    if (sku.discountAmount) patch.discountAmount = null;
  }
  if (rules.forcedFulfillmentKind && sku.fulfillmentKind !== undefined && sku.fulfillmentKind !== rules.forcedFulfillmentKind) {
    patch.fulfillmentKind = rules.forcedFulfillmentKind;
  }
  return Object.keys(patch).length === 0 ? sku : { ...sku, ...patch };
}

/** Provided by the product form (from its `isGiftCard` and fulfilment kind); read with `useProductKindRules`. */
export const ProductKindRulesContext = createContext<ProductKindRules>(DEFAULT_PRODUCT_KIND_RULES);

export function useProductKindRules(): ProductKindRules {
  return useContext(ProductKindRulesContext);
}
