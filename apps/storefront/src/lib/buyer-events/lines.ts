// Buyer event payload pieces from the storefront's own data: money in minor
// units (the storefront edge holds decimal page-currency amounts), products,
// cart lines and the checkout. Only ids, titles, quantities and prices: never
// a line's buyer inputs.

import { getCurrencyCode, getDecimalPlaces } from "@scalius/shared/currency";
import { toMinor } from "@scalius/shared/money";
import {
  BUYER_EVENT_LIMITS,
  type BuyerCheckout,
  type BuyerLine,
  type BuyerMerchandise,
  type BuyerMoney,
} from "@scalius/shared/plugins/buyer-events";

/** A decimal amount of `currency` (the page's by default) as event money; null when not a finite amount. */
export function buyerMoney(amount: number | null | undefined, currency: string = getCurrencyCode()): BuyerMoney | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  return { amountMinor: toMinor(amount, getDecimalPlaces(currency)), currency };
}

/** Text an event carries: trimmed and bounded. */
export function eventText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, BUYER_EVENT_LIMITS.text) : "";
}

export function merchandise(input: {
  productId: string;
  variantId?: string | null;
  title?: string | null;
  price?: number | null;
  currency?: string;
}): BuyerMerchandise {
  const variantId = input.variantId && input.variantId !== "default" ? input.variantId : null;
  return { productId: input.productId, variantId, title: eventText(input.title), price: buyerMoney(input.price, input.currency) };
}

/** A cart line (the cart store's) with `quantity` units. */
export function cartLine(
  item: { id: string; variantId?: string; name?: string; price?: number },
  quantity: number,
): BuyerLine {
  return { merchandise: merchandise({ productId: item.id, variantId: item.variantId, title: item.name, price: item.price }), quantity };
}

/** The lines of a cart (the cart store's items), bounded. */
export function cartLines(items: Readonly<Record<string, { id: string; variantId?: string; name?: string; price?: number; quantity: number }>>): BuyerLine[] {
  return Object.values(items).slice(0, BUYER_EVENT_LIMITS.lines).map((item) => cartLine(item, item.quantity));
}

export function buyerCheckout(id: string | null | undefined, lines: BuyerLine[], total: BuyerMoney | null): BuyerCheckout {
  return {
    id: typeof id === "string" && id.trim() ? id.trim() : null,
    lines: lines.slice(0, BUYER_EVENT_LIMITS.lines),
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    total,
  };
}
