/**
 * Store app rules that block checkout ("At most 10 per order"), on the cart
 * page: a rule about a line is said under that line, a rule about the whole
 * cart in the banner above the checkout action. The messages are the app's
 * own words, always rendered as text.
 */
import type { CartRuleError } from "../api/orders";
import type { CartItem } from "../../store/cart";

export interface CartRuleErrorGroups {
  /** Rules about one line, by its cart key. */
  lines: Record<string, CartRuleError[]>;
  /** Rules about the whole cart, or about a line no longer in it. */
  cart: CartRuleError[];
}

/** One list from every answer (the availability check, the quote), each rule once. */
export function mergeCartRuleErrors(
  ...sources: ReadonlyArray<readonly CartRuleError[]>
): CartRuleError[] {
  const seen = new Set<string>();
  return sources.flat().filter((error) => {
    const key = JSON.stringify([error.code, error.message, error.cartKey]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Each rule on its line by its exact cart key (never by position); the rest are the cart's. */
export function groupCartRuleErrors(
  errors: readonly CartRuleError[],
  items: Record<string, CartItem>,
): CartRuleErrorGroups {
  const groups: CartRuleErrorGroups = { lines: {}, cart: [] };
  for (const error of errors) {
    const cartKey = error.cartKey?.trim();
    if (cartKey && Object.prototype.hasOwnProperty.call(items, cartKey)) {
      groups.lines[cartKey] = [...(groups.lines[cartKey] ?? []), error];
    }
    else groups.cart.push(error);
  }
  return groups;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** The element a line's controls name with `aria-describedby`. */
export function cartLineRuleErrorsId(position: number): string {
  return `cartLineRuleErrors-${position}`;
}

/** A line's rules under its controls (the cart lines are an HTML string). */
export function renderCartLineRuleErrors(errors: readonly CartRuleError[], id: string): string {
  const messages = errors.map(({ message }) => message).filter(Boolean);
  if (messages.length === 0) return "";
  return `<ul id="${escapeHtml(id)}" class="mt-1 space-y-0.5 text-xs font-medium text-destructive" data-cart-line-rule-errors>${messages
    .map((message) => `<li>${escapeHtml(message)}</li>`)
    .join("")}</ul>`;
}

/**
 * Fills the banner above the checkout action: "This order can't be placed
 * yet.", the whole-cart rules, and a pointer to the lines when a rule is on
 * one. Hidden when nothing blocks. Returns whether it shows.
 */
export function fillCartRuleBanner(
  banner: HTMLElement,
  groups: CartRuleErrorGroups,
  copy: { cartRulesBlockedText: string; reviewCartItemsText: string },
): boolean {
  const onLines = Object.keys(groups.lines).length > 0;
  const blocked = onLines || groups.cart.length > 0;
  banner.replaceChildren();
  banner.classList.toggle("hidden", !blocked);
  if (!blocked) return false;

  const heading = document.createElement("p");
  heading.className = "font-semibold";
  heading.textContent = copy.cartRulesBlockedText;
  banner.append(heading);

  const messages = groups.cart.map(({ message }) => message).filter(Boolean);
  if (messages.length > 0) {
    const list = document.createElement("ul");
    list.className = "mt-1 list-disc space-y-0.5 ps-5";
    for (const message of messages) {
      const item = document.createElement("li");
      item.textContent = message;
      list.append(item);
    }
    banner.append(list);
  }
  if (onLines) {
    const pointer = document.createElement("p");
    pointer.className = "mt-1";
    pointer.textContent = copy.reviewCartItemsText;
    banner.append(pointer);
  }
  return true;
}
