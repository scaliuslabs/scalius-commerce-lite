/**
 * Buyer inputs under a cart line: "Engraving: Anika (+৳200)", one per row,
 * with an Edit link back to the product page (Wave A §3.2, §3.4). The line's
 * view (`cartLineView`) words them once for the cart page and the drawer.
 */
import { checkoutText } from "@/lib/checkout-text";
import { formatMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";

import { fromMinor } from "@scalius/shared/money";
import { presentLineEntry, type LineEntryWords } from "@scalius/shared/line-entry-words";
import type { CartLineProperty } from "@/store/cart";
import { pagePath } from "@/lib/presence-url";

/** "+৳200" for a surcharge in minor units of the page currency. */
export function formatPropertySurcharge(
  priceMinor: number,
  surchargeText: string,
  currencyCode: string = getCurrencyCode(),
): string {
  const price = formatMoney(fromMinor(priceMinor, getDecimalPlaces(currencyCode)), { code: currencyCode });
  return checkoutText(surchargeText || "+{price}", { price });
}

/**
 * "Label: value (+৳200)"; the surcharge only when the input adds one. The
 * platform's own words ("Yes", "Add-on") are the page's (`words`, the
 * checkout language's); the merchant's and apps' words stay as frozen.
 */
export function cartLinePropertyText(
  property: Pick<CartLineProperty, "label" | "displayValue" | "priceMinor"> & { key?: string; value?: string; type?: string },
  surchargeText: string,
  words: LineEntryWords,
  currencyCode?: string,
): string {
  const shown = presentLineEntry({ ...property, key: property.key ?? "" }, words);
  const base = `${shown.label}: ${shown.displayValue}`;
  return property.priceMinor > 0
    ? `${base} (${formatPropertySurcharge(property.priceMinor, surchargeText, currencyCode)})`
    : base;
}

/** The product page a line's Edit link opens, on the line's own SKU. */
export function cartLineEditHref(item: { slug?: string; variantId?: string }): string | null {
  if (!item.slug) return null;
  const query = item.variantId ? `?${new URLSearchParams({ variant: item.variantId })}` : "";
  return pagePath(`/products/${encodeURIComponent(item.slug)}${query}`);
}

/**
 * The element that describes a line's controls with its buyer inputs: the
 * inputs are what tell two lines of one SKU apart ("Engraving: Ana"), and
 * they stay out of the controls' short names (`cartLineName`).
 */
export function cartLineInputsId(position: number): string {
  return `cartLineInputs-${position}`;
}
