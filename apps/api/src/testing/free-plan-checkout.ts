/**
 * The buyer's checkout through the real Worker, for the plan budget and the write-scaling gate: a tax quote
 * (it fixes the price the commit must match) and the commit, over the seeded catalogue's single-SKU lines.
 */
import { expect } from "vitest";

import { cartItems } from "./free-plan-seed";
import { STORE, type FreePlanStore } from "./free-plan-store";

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export async function taxQuote(store: FreePlanStore, lines: number): Promise<{ quoteFingerprint: string }> {
  const response = await store.worker.fetch(jsonRequest(`${STORE.api}/api/v1/orders/tax-quote`, {
    items: cartItems(lines).map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
    city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: [],
  }));
  const body = await response.json() as { data: { quoteFingerprint: string } };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.data;
}

/**
 * Commit an order of `lines` single-SKU lines at a quote's fingerprint; returns its id. Each buyer's
 * phone is new, numbered from the store's own orders, so a store rewound to a checkpoint numbers them alike.
 */
export async function placeOrder(store: FreePlanStore, lines: number, quote: string): Promise<string> {
  const { orders } = store.sqlite.prepare("SELECT count(*) AS orders FROM orders").get() as { orders: number };
  const response = await store.worker.fetch(jsonRequest(`${STORE.api}/api/v1/orders`, {
    checkoutRequestId: `budget_${crypto.randomUUID()}`,
    expectedQuoteFingerprint: quote,
    customerName: "Budget Buyer",
    customerPhone: `+88017${String(10000000 + orders)}`,
    customerEmail: "buyer@shop.test",
    shippingAddress: "House 1, Road 2, Gulshan",
    city: "city_1",
    zone: "zone_1",
    notes: null,
    items: cartItems(lines),
    discountCodes: [],
    shippingCharge: 60,
    shippingMethodId: "m_std",
    paymentMethod: "cod",
  }));
  const body = await response.json() as { data: { orderId: string } };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body.data.orderId;
}
