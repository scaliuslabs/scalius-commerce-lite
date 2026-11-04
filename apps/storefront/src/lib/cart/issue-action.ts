import type { CartValidationIssue } from "../api/orders";
import { pagePath } from "@/lib/presence-url";
import { formatCount } from "@/lib/store-time-zone";
import { cartLineCopy } from "@/lib/cart-line-copy";
import { cartLineName } from "./item-options";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function inlineJsString(value: string): string {
  return escapeHtml(JSON.stringify(value));
}

const LINK = "inline-flex min-h-11 items-center text-xs font-semibold text-foreground underline underline-offset-2";

/**
 * A line issue's repair: a short word on the control, and a name that holds
 * that word and names the line, so two sold-out sizes of one product read as
 * two lines. `describedBy` is the line's own description (its buyer inputs and
 * app rules), as an ` aria-describedby="…"` attribute or "".
 */
export function renderCartIssueAction(
  cartKey: string,
  issue: CartValidationIssue,
  line: { name: string; slug?: string; options?: unknown; purchaseOption?: { title: string } | null } | undefined,
  describedBy = "",
): string {
  const copy = cartLineCopy();
  const jsKey = inlineJsString(cartKey);
  const lineName = cartLineName(line ?? { name: issue.productName ?? "" });
  const label = (name: string) => ` aria-label="${escapeHtml(name)}"${describedBy}`;
  const productSlug = line?.slug;
  if (issue.action === "reduce_quantity" && typeof issue.availableQuantity === "number" && issue.availableQuantity > 0) {
    const count = formatCount(Math.floor(issue.availableQuantity));
    return `<button type="button" class="${LINK} sm:min-h-6"${label(copy.updateQuantityFor(count, lineName))} onclick="window.reduceCartIssueItem(${jsKey})">${escapeHtml(copy.updateQuantity(count))}</button>`;
  }
  if (issue.action === "refresh_item" && typeof issue.currentPrice === "number") {
    return `<button type="button" class="${LINK} sm:min-h-6"${label(copy.refreshPriceFor(lineName))} onclick="window.refreshCartIssueItem(${jsKey})">${escapeHtml(copy.refreshPrice)}</button>`;
  }
  // A required or refused buyer input: back to the product page with the
  // line's inputs (handed over in session storage, never the URL).
  if (issue.action === "edit_properties" && productSlug) {
    const query = issue.variantId ? `?${new URLSearchParams({ variant: issue.variantId })}` : "";
    return `<a class="${LINK} sm:min-h-0" href="${escapeHtml(pagePath(`/products/${encodeURIComponent(productSlug)}${query}`))}"${label(copy.editDetailsFor(lineName))} onclick="return window.editCartLine ? window.editCartLine(${jsKey}) : true">${escapeHtml(copy.editDetails)}</a>`;
  }
  if (issue.action === "select_variant" && productSlug) {
    return `<a class="${LINK} sm:min-h-0" href="${escapeHtml(pagePath(`/products/${encodeURIComponent(productSlug)}`))}"${label(copy.chooseOptionFor(lineName))}>${escapeHtml(copy.chooseOption)}</a>`;
  }
  return `<button type="button" class="inline-flex min-h-11 items-center text-xs font-semibold text-destructive underline underline-offset-2 sm:min-h-6"${label(copy.removeFor(lineName))} onclick="window.removeCartIssueItem(${jsKey})">${escapeHtml(copy.remove)}</button>`;
}
