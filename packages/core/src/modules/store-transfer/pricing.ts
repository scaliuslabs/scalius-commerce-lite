// Catalog pricing as an import file states it: Shopify and WooCommerce write
// the selling price and the pre-sale ("compare-at" / regular) price, Scalius
// stores a base price and a discount. Both directions go through the same
// integer minor-unit rounding the storefront uses.

import { discountedPriceMinor, fromMinor, percentToBps, toMinor } from "@scalius/shared/money";
import type { StoreCurrency } from "../settings";

export interface StoredPricing {
  price: number;
  discountType: string | null;
  discountPercentage: number | null;
  discountAmount: number | null;
}

/** The price a buyer pays for stored pricing, in major units. */
export function effectivePrice(stored: StoredPricing, currency: StoreCurrency): number {
  const priceMinor = toMinor(stored.price, currency.decimalPlaces);
  const minor = discountedPriceMinor(
    priceMinor,
    stored.discountType === "flat" ? "flat" : "percentage",
    percentToBps(stored.discountPercentage),
    toMinor(stored.discountAmount ?? 0, currency.decimalPlaces),
    currency.priceIncrementMinor,
  );
  return fromMinor(minor, currency.decimalPlaces);
}

/** Selling price and compare-at price (null when not on sale) for an export row. */
export function exportPricing(stored: StoredPricing, currency: StoreCurrency): { price: number; compareAtPrice: number | null } {
  const price = effectivePrice(stored, currency);
  return price < stored.price ? { price, compareAtPrice: stored.price } : { price: stored.price, compareAtPrice: null };
}
