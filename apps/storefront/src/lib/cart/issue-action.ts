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
    return `<button type="button" class="text-xs font-semibold text-primary hover:underline" onclick="window.reduceCartIssueItem(${jsKey})">Update quantity</button>`;
  }
  if (issue.action === "refresh_item" && typeof issue.currentPrice === "number") {
    return `<button type="button" class="text-xs font-semibold text-primary hover:underline" onclick="window.refreshCartIssueItem(${jsKey})">Refresh price</button>`;
  }
  if (issue.action === "select_variant" && productSlug) {
    return `<a class="text-xs font-semibold text-primary hover:underline" href="${escapeHtml(`/products/${encodeURIComponent(productSlug)}`)}">Choose option</a>`;
  }
  return `<button type="button" class="text-xs font-semibold text-destructive hover:underline" onclick="window.removeCartIssueItem(${jsKey})">Remove item</button>`;
}
