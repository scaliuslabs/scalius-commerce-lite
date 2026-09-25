/**
 * Buyer inputs under a cart line: "Engraving: Anika (+৳200)", one per row,
 * with an Edit link back to the product page (Wave A §3.2, §3.4). Shared by
 * the cart page and the cart flyout so both say the same thing.
 */
import { formatMoney, getCurrencyCode, getDecimalPlaces } from "@scalius/shared/currency";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { fromMinor } from "@scalius/shared/money";
import type { CartLineProperty } from "@/store/cart";

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
  return formatCheckoutLanguageText(surchargeText || "+{price}", { price });
}

/** "Label: value (+৳200)"; the surcharge only when the input adds one. */
export function cartLinePropertyText(
  property: Pick<CartLineProperty, "label" | "displayValue" | "priceMinor">,
  surchargeText: string,
  currencyCode?: string,
): string {
  const base = `${property.label}: ${property.displayValue}`;
  return property.priceMinor > 0
    ? `${base} (${formatPropertySurcharge(property.priceMinor, surchargeText, currencyCode)})`
    : base;
}

/** The product page a line's Edit link opens, on the line's own SKU. */
export function cartLineEditHref(item: { slug?: string; variantId?: string }): string | null {
  if (!item.slug) return null;
  const query = item.variantId ? `?${new URLSearchParams({ variant: item.variantId })}` : "";
  return `/products/${encodeURIComponent(item.slug)}${query}`;
}

/**
 * The inputs block as HTML (every value escaped). The Edit link works as a
 * plain link; with the cart script it also hands the line to the product
 * page (`window.editCartLine`), which replaces it on "Update cart".
 */
export function renderCartLineProperties(
  item: { properties?: CartLineProperty[]; slug?: string; variantId?: string; name: string },
  options: {
    surchargeText: string;
    editText: string;
    editLabelText: string;
    /** The line key as an escaped inline-JS string literal. */
    jsCartKey: string;
  },
): string {
  const properties = item.properties ?? [];
  if (properties.length === 0) return "";
  const rows = properties
    .map((property) =>
      `<li class="break-words">${escapeHtml(cartLinePropertyText(property, options.surchargeText))}</li>`)
    .join("");
  const href = cartLineEditHref(item);
  const edit = href
    ? `<a href="${escapeHtml(href)}" class="mt-0.5 inline-flex min-h-11 items-center text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary sm:min-h-0" aria-label="${escapeHtml(formatCheckoutLanguageText(options.editLabelText, { item: item.name }))}" onclick="return window.editCartLine ? window.editCartLine(${options.jsCartKey}) : true" data-cart-line-edit>${escapeHtml(options.editText)}</a>`
    : "";
  return `<div class="mt-0.5 text-sm text-muted-foreground" data-cart-line-properties><ul>${rows}</ul>${edit}</div>`;
}
