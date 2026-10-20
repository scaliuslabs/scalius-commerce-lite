import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { OutboxEvent } from "@scalius/core/modules/events";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { createWebhookRepresentationResolver } from "./representations";

let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => { ({ sqlite, db } = createSqliteD1Database()); });
afterEach(() => sqlite.close());
const event = (fields: Pick<OutboxEvent, "topic" | "resourceType" | "resourceId" | "facts">): OutboxEvent => ({
  id: "evt_test", occurredAt: 1, ...fields,
});

describe("sealed event representations", () => {
  it("presents an order resource-shaped: minor units beside the currency, lines by id, contact in full for the delivery to project", async () => {
    // The line names a product snapshot only; its catalog row does not matter here.
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, shipping_country_code, shipping_locality, city, zone, status, requires_shipping, total_amount_minor, currency_code)
      VALUES ('ord_event', 'Buyer', '+8801711000001', 'buyer@shop.test', 'House 1', 'BD', 'Dhaka', 'city', 'zone', 'pending', 1, 12550, 'BDT');
      INSERT INTO order_items (id, order_id, product_id, quantity, product_name, unit_price_minor, line_subtotal_minor)
      VALUES ('item_1', 'ord_event', 'prod_1', 2, 'Panjabi', 6275, 12550);`);
    const result = await createWebhookRepresentationResolver(db)(event({
      topic: "order.created", resourceType: "order", resourceId: "ord_event",
      facts: { orderId: "ord_event", status: "pending", paymentStatus: "unpaid", channel: "online_store" },
    }));
    expect(EVENT_REPRESENTATION_SCHEMAS.order.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      id: "ord_event", currency: "BDT", totalMinor: 12550,
      contact: { name: "Buyer", phone: "+8801711000001", email: "buyer@shop.test" },
      shippingAddress: { line1: "House 1", locality: "Dhaka", countryCode: "BD", placeIds: { city: "city", zone: "zone" } },
      lines: [{ id: "item_1", productId: "prod_1", quantity: 2, unitPriceMinor: 6275, subtotalMinor: 12550, title: "Panjabi" }],
    });
    expect(result).not.toHaveProperty("customerName");
    expect(result).not.toHaveProperty("totalAmount");
  });

  it("presents payments in minor units without stored provider metadata", async () => {
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone)
      VALUES ('ord_event', 'Buyer', '+8801711000001', 'House 1', 'city', 'zone');
      INSERT INTO order_payments (id, order_id, amount_minor, payment_method, status, metadata)
      VALUES ('pay_event', 'ord_event', 1250, 'cod', 'confirmed', '{"private":"provider-payload"}');`);
    const result = await createWebhookRepresentationResolver(db)(event({
      topic: "payment.updated", resourceType: "payment", resourceId: "pay_event",
      facts: { paymentId: "pay_event", orderId: "ord_event", provider: "cod", previousStatus: null, status: "confirmed" },
    }));
    expect(result).toMatchObject({ id: "pay_event", amountMinor: 1250, method: "cod", status: "confirmed" });
    expect(JSON.stringify(result)).not.toContain("provider-payload");
    expect(result).not.toHaveProperty("amount");
  });

  it("reads the exact fulfillment beyond the order detail list window", async () => {
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone)
      VALUES ('ord_fulfillment', 'Buyer', '+8801711000001', 'House 1', 'city', 'zone');`);
    const insert = sqlite.prepare(`INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type, created_at)
      VALUES (?, 'ord_fulfillment', 'service', ?, 'system', ?)`);
    for (let index = 1; index <= 201; index += 1) insert.run(`fulfillment_${index}`, `request-${index}`, index);
    const result = await createWebhookRepresentationResolver(db)(event({
      topic: "fulfillment.created", resourceType: "fulfillment", resourceId: "fulfillment_201",
      facts: { fulfillmentId: "fulfillment_201", orderId: "ord_fulfillment", kind: "service", locationId: null },
    }));
    expect(result).toMatchObject({ id: "fulfillment_201", kind: "service", status: "active", lines: [] });
  });

  it("reads a gift card and a delayed transaction without leaking codes", async () => {
    sqlite.exec(`INSERT INTO gift_cards (id, code_hash, code_ciphertext, code_last4, currency_code, initial_amount_minor, source)
      VALUES ('gc_event0001', 'private-hash', 'private-cipher', '1234', 'BDT', 100, 'manual');`);
    const insert = sqlite.prepare(`INSERT INTO gift_card_transactions
      (id, gift_card_id, kind, amount_minor, balance_after_minor, idempotency_key, actor_type, reason, created_at)
      VALUES (?, 'gc_event0001', 'adjust', 1, ?, ?, 'system', 'test adjustment', ?)`);
    for (let index = 1; index <= 201; index += 1) insert.run(`gct_event_${index.toString().padStart(4, "0")}`, index, `event-${index}`, index);
    const resolve = createWebhookRepresentationResolver(db);
    const transaction = await resolve(event({ topic: "gift_card_transaction.created", resourceType: "gift_card_transaction", resourceId: "gct_event_0001",
      facts: { giftCardId: "gc_event0001", transactionId: "gct_event_0001", kind: "adjust", orderId: null } }));
    expect(transaction).toMatchObject({ id: "gct_event_0001", amountMinor: 1, balanceAfterMinor: 1, currency: "BDT", actorType: "system" });
    const card = await resolve(event({ topic: "gift_card.created", resourceType: "gift_card", resourceId: "gc_event0001",
      facts: { giftCardId: "gc_event0001", previousStatus: null, status: "active" } }));
    expect(card).toMatchObject({ last4: "1234", initialAmountMinor: 100, currency: "BDT" });
    expect(JSON.stringify(card)).not.toContain("private-hash");
    expect(JSON.stringify(card)).not.toContain("private-cipher");
  });

  it("is null for a resource that no longer exists, for every type", async () => {
    const resolve = createWebhookRepresentationResolver(db);
    for (const type of Object.keys(EVENT_REPRESENTATION_SCHEMAS) as Array<keyof typeof EVENT_REPRESENTATION_SCHEMAS>) {
      const facts = { orderId: "ord_missing", giftCardId: "gc_missing", objectType: "custom.thing" };
      expect(await resolve(event({ topic: "order.updated", resourceType: type, resourceId: "missing", facts: facts as never })), type).toBeNull();
    }
  });
});
