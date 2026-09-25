import type { CartValidationIssue } from "../api/orders";

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

export function renderCartIssueAction(
  cartKey: string,
  issue: CartValidationIssue,
  productSlug?: string,
): string {
  const jsKey = inlineJsString(cartKey);
  if (issue.action === "reduce_quantity" && typeof issue.availableQuantity === "number" && issue.availableQuantity > 0) {
    return `<button type="button" class="inline-flex min-h-11 items-center text-xs font-semibold text-foreground underline underline-offset-2 sm:min-h-0" onclick="window.reduceCartIssueItem(${jsKey})">Update quantity</button>`;
  }
  if (issue.action === "refresh_item" && typeof issue.currentPrice === "number") {
    return `<button type="button" class="inline-flex min-h-11 items-center text-xs font-semibold text-foreground underline underline-offset-2 sm:min-h-0" onclick="window.refreshCartIssueItem(${jsKey})">Refresh price</button>`;
  }
  // A required or refused buyer input: back to the product page with the
  // line's inputs (handed over in session storage, never the URL).
  if (issue.action === "edit_properties" && productSlug) {
    const query = issue.variantId ? `?${new URLSearchParams({ variant: issue.variantId })}` : "";
    return `<a class="inline-flex min-h-11 items-center text-xs font-semibold text-foreground underline underline-offset-2 sm:min-h-0" href="${escapeHtml(`/products/${encodeURIComponent(productSlug)}${query}`)}" onclick="return window.editCartLine ? window.editCartLine(${jsKey}) : true">Edit details</a>`;
  }
  if (issue.action === "select_variant" && productSlug) {
    return `<a class="inline-flex min-h-11 items-center text-xs font-semibold text-foreground underline underline-offset-2 sm:min-h-0" href="${escapeHtml(`/products/${encodeURIComponent(productSlug)}`)}">Choose option</a>`;
  }
  return `<button type="button" class="inline-flex min-h-11 items-center text-xs font-semibold text-destructive underline underline-offset-2 sm:min-h-0" onclick="window.removeCartIssueItem(${jsKey})">Remove item</button>`;
}
