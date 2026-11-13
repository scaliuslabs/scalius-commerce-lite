/**
 * The one order of the money rows under a cart or an order, on every surface
 * that lists them: the drawer, the cart page, quick checkout, the receipt and
 * the account's order page. What the lines cost, what delivery adds, what the
 * store takes off, the tax, then the total (gift cards, a payment, follow it).
 * Each row carries `data-summary-row`; money-summary-order.test.ts holds every
 * surface to this order. The drawer once listed its discounts above its
 * subtotal while the cart page listed them after delivery.
 */
export const MONEY_SUMMARY_ORDER = ["subtotal", "delivery", "discount", "tax", "total"] as const;

export type MoneySummaryRow = (typeof MONEY_SUMMARY_ORDER)[number];
