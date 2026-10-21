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
  /** Package weight: only for what is packed (never a gift card, a download or a service). */
  showWeight: boolean;
  /** Product and variant discounts: a gift card is worth its price, so it is never discounted. */
  showDiscount: boolean;
  /** Track quantity, quantities and bulk quantity edits: gift cards are untracked. */
  showInventory: boolean;
  /** The fulfilment kind every SKU must have, or null when the merchant chooses (the Fulfilment select). */
  forcedFulfillmentKind: "digital" | null;
  /** The product's Fulfilment select (a gift card is digital). */
  fulfilmentMode: ProductFulfilmentMode;
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
    showWeight: kind === "physical" || kind === "mixed",
    showDiscount: !giftCard,
    showInventory: !giftCard,
    forcedFulfillmentKind: giftCard ? "digital" : null,
    fulfilmentMode: kind,
  };
}

/** A physical product with nothing hidden: what the editor shows without a provider. */
export const DEFAULT_PRODUCT_KIND_RULES: ProductKindRules = productKindRules({});

/**
 * A digital SKU (not a gift card's): its quantity is never typed in. With
 * tracking on it is the licence keys imported; off, downloads are unlimited
 * (packages/core/src/modules/digital/README.md, "Pool = stock").
 */
export function isDigitalSku(rules: ProductKindRules, sku: { fulfillmentKind?: string | null }): boolean {
  if (rules.giftCard) return false;
  if (rules.fulfilmentMode === "mixed") return sku.fulfillmentKind === "digital";
  return rules.fulfilmentMode === "digital";
}

/**
 * Whether a digital SKU tracks quantity: exactly when it delivers licence
 * keys (a ready key pool), since its keys are its stock; files are
 * unlimited, so a file-only SKU tracks none. Importing its first keys turns
 * tracking on (the server does it with the pool). `hasKeyPool` is undefined
 * while the pools load: a saved SKU keeps what it has, a new one tracks none.
 */
export function digitalSkuTracks(saved: { trackInventory?: boolean } | null, hasKeyPool: boolean | undefined): boolean {
  if (hasKeyPool !== undefined) return hasKeyPool;
  // A saved SKU without the flag tracked (the API's default).
  return saved ? saved.trackInventory !== false : false;
}

type ConstrainableSku = {
  trackInventory: boolean;
  stock?: number;
  discountType?: "percentage" | "flat";
  discountPercentage?: number | null;
  discountAmount?: number | null;
  compareAt?: number | null;
  fulfillmentKind?: "physical" | "digital" | "service";
};

/**
 * A SKU as the kind allows it to be saved: a gift card's SKU is untracked,
 * undiscounted and digital (the API refuses anything else), and a digital
 * SKU carries no typed quantity. `keepStock` keeps a saved SKU's recorded
 * quantity so a save never writes stock; new rows start at 0. Returns the
 * same object when nothing changes, so memoised rows keep their identity.
 */
export function constrainSkuForKind<T extends ConstrainableSku>(sku: T, rules: ProductKindRules, keepStock = false): T {
  const patch: Partial<ConstrainableSku> = {};
  if (!rules.showInventory) {
    if (sku.trackInventory) patch.trackInventory = false;
  }
  if ((!rules.showInventory || isDigitalSku(rules, sku)) && !keepStock && sku.stock !== undefined && sku.stock !== 0) {
    patch.stock = 0;
  }
  if (!rules.showDiscount) {
    if (sku.discountType !== undefined && sku.discountType !== "percentage") patch.discountType = "percentage";
    if (sku.discountPercentage) patch.discountPercentage = null;
    if (sku.discountAmount) patch.discountAmount = null;
    if (sku.compareAt != null) patch.compareAt = null;
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
