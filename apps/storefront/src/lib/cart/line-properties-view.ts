/**
 * Buyer inputs under a cart line: "Engraving: Anika (+৳200)", one per row,
 * with an Edit link back to the product page (Wave A §3.2, §3.4). Shared by
 * the cart page and the cart flyout so both say the same thing.
 */
import { checkoutText } from "@/lib/checkout-text";
import { formatMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";

import { fromMinor } from "@scalius/shared/money";
import { presentLineEntry, type LineEntryWords } from "@scalius/shared/line-entry-words";
import type { CartLineAdjustment, CartLineProperty } from "@/store/cart";
import { pagePath } from "@/lib/presence-url";
import { cartLineName } from "./item-options";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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

/**
 * The inputs block as HTML (every value escaped). The Edit link works as a
 * plain link; with the cart script it also hands the line to the product
 * page (`window.editCartLine`), which replaces it on "Update cart". With
 * `inputsId`, a line with inputs gives their list that id; `describedBy` is
 * the Edit link's ` aria-describedby="…"` attribute (or "").
 */
export function renderCartLineProperties(
  item: Parameters<typeof cartLineName>[0] & { properties?: CartLineProperty[]; adjustments?: CartLineAdjustment[]; slug?: string; variantId?: string },
  options: {
    surchargeText: string;
    /** The platform's words on the line, in the page's language. */
    words: LineEntryWords;
    editText: string;
    editLabelText: string;
    /** The line key as an escaped inline-JS string literal. */
    jsCartKey: string;
    inputsId?: string;
    describedBy?: string;
  },
): string {
  const properties = item.properties ?? [];
  // Apps' add-ons are line components too, but not inputs: no Edit link of their own.
  const adjustments = item.adjustments ?? [];
  if (properties.length === 0 && adjustments.length === 0) return "";
  // An input's row names its key: the app inputs' controls replace their rows once drawn.
  const rows = [
    ...properties.map((property) =>
      `<li class="break-words" data-property-key="${escapeHtml(property.key)}">${escapeHtml(cartLinePropertyText(property, options.surchargeText, options.words))}</li>`),
    ...adjustments.map((adjustment) =>
      `<li class="break-words">${escapeHtml(cartLinePropertyText(adjustment, options.surchargeText, options.words))}</li>`),
  ].join("");
  const href = properties.length > 0 ? cartLineEditHref(item) : null;
  const listId = properties.length > 0 && options.inputsId ? ` id="${escapeHtml(options.inputsId)}"` : "";
  const edit = href
    ? `<a href="${escapeHtml(href)}" class="mt-0.5 inline-flex min-h-11 items-center text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary sm:min-h-0" aria-label="${escapeHtml(checkoutText(options.editLabelText, { item: cartLineName(item) }))}"${options.describedBy ?? ""} onclick="return window.editCartLine ? window.editCartLine(${options.jsCartKey}) : true" data-cart-line-edit>${escapeHtml(options.editText)}</a>`
    : "";
  return `<div class="mt-0.5 text-sm text-muted-foreground" data-cart-line-properties><ul${listId}>${rows}</ul>${edit}</div>`;
}
