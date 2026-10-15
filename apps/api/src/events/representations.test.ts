import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { OutboxEvent } from "@scalius/core/modules/events";
import { createWebhookRepresentationResolver } from "./representations";

let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => { ({ sqlite, db } = createSqliteD1Database()); });
afterEach(() => sqlite.close());
const event = (fields: Pick<OutboxEvent, "topic" | "resourceType" | "resourceId" | "facts">): OutboxEvent => ({
  id: "evt_test", occurredAt: 1, ...fields,
});

describe("new commerce event representations", () => {
  it("presents payments in major units without stored provider metadata", async () => {
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone)
      VALUES ('ord_event', 'Buyer', '+8801711000001', 'House 1', 'city', 'zone');
      INSERT INTO order_payments (id, order_id, amount_minor, payment_method, status, metadata)
      VALUES ('pay_event', 'ord_event', 1250, 'cod', 'confirmed', '{"private":"provider-payload"}');`);
    const result = await createWebhookRepresentationResolver(db)(event({
      topic: "payment.updated", resourceType: "payment", resourceId: "pay_event",
      facts: { paymentId: "pay_event", orderId: "ord_event", provider: "cod", previousStatus: null, status: "confirmed" },
    }));
    expect(result).toMatchObject({ id: "pay_event", amount: 12.5, giftCard: null });
    expect(result).not.toHaveProperty("metadata");
    expect(result).not.toHaveProperty("amountMinor");
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

  it("reads a delayed gift-card transaction beyond the admin list window without leaking codes", async () => {
    sqlite.exec(`INSERT INTO gift_cards (id, code_hash, code_ciphertext, code_last4, currency_code, initial_amount_minor, source)
      VALUES ('gc_event0001', 'private-hash', 'private-cipher', '1234', 'BDT', 100, 'manual');`);
    const insert = sqlite.prepare(`INSERT INTO gift_card_transactions
      (id, gift_card_id, kind, amount_minor, balance_after_minor, idempotency_key, actor_type, reason, created_at)
      VALUES (?, 'gc_event0001', 'adjust', 1, ?, ?, 'system', 'test adjustment', ?)`);
    for (let index = 1; index <= 201; index += 1) insert.run(`gct_event_${index.toString().padStart(4, "0")}`, index, `event-${index}`, index);
    const resolve = createWebhookRepresentationResolver(db);
    const transaction = await resolve(event({ topic: "gift_card.transaction", resourceType: "transaction", resourceId: "gct_event_0001",
      facts: { giftCardId: "gc_event0001", transactionId: "gct_event_0001", kind: "adjust", orderId: null } }));
    expect(transaction).toMatchObject({ id: "gct_event_0001", amount: 0.01, balanceAfter: 0.01, actorName: null });
    const card = await resolve(event({ topic: "gift_card.created", resourceType: "gift_card", resourceId: "gc_event0001",
      facts: { giftCardId: "gc_event0001", previousStatus: null, status: "active" } }));
    expect(card).toMatchObject({ giftCard: { last4: "1234", initialAmount: 1, balance: 2.01 } });
    expect(JSON.stringify(card)).not.toContain("private-hash");
    expect(JSON.stringify(card)).not.toContain("private-cipher");
  });
});
