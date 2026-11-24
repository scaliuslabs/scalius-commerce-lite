/**
 * The one order of the money rows under a cart or an order, on every surface
 * that lists them: the drawer, the cart page, quick checkout, the receipt and
 * the account's order page. How many items (where a theme shows the count), what the items cost, the apps' add-ons (each its
 * own row, so Subtotal is the items alone wherever they show), what delivery
 * adds, what the store takes off, the tax, then the total, then what paid
 * it (`paid`: each gift card) and what is left to pay (`due`, which ranks with the total).
 * Each row carries `data-summary-row`; money-summary-order.test.ts holds every
 * surface to this order. The drawer once listed its discounts above its
 * subtotal while the cart page listed them after delivery.
 */
export const MONEY_SUMMARY_ORDER = ["items", "subtotal", "add-on", "delivery", "discount", "tax", "total", "paid", "due"] as const;

export type MoneySummaryRow = (typeof MONEY_SUMMARY_ORDER)[number];
