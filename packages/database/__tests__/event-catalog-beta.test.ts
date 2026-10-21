import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVENT_TOPIC_RESOURCE, parseEventFacts, type EventTopic } from "../../shared/src/events";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

describe("beta event catalog on the migrated schema", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = createMigratedSqlite();
    sqlite.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('cus_beta', 'Private Buyer', '+8801711111111');
      INSERT INTO products (id, name, slug) VALUES ('prod_beta', 'Product', 'beta-product');
      INSERT INTO product_variants (id, product_id, sku, is_default) VALUES ('var_beta', 'prod_beta', 'BETA', 1);
      INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, status)
        VALUES ('ord_beta', 'cus_beta', 'Private Buyer', '+8801711111111', 'Private address', 'city', 'zone', 'confirmed');
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor)
        VALUES ('item_beta', 'ord_beta', 'prod_beta', 'var_beta', 1, 1000);
    `);
  });
  afterEach(() => sqlite.close());

  function demand(filter: string): void {
    sqlite.prepare("INSERT INTO event_demand (filter) VALUES (?)").run(filter);
  }

  function facts() {
    return (sqlite.prepare("SELECT id, topic, resource_type, resource_id, data, status FROM event_outbox ORDER BY rowid")
      .all() as Array<{ id: string; topic: EventTopic; resource_type: string; resource_id: string; data: string; status: string }>).map((row) => {
      expect(row.id).toMatch(/^evt_\d{13}[0-9a-f]{12}$/);
      expect(row.status).toBe("pending");
      expect(row.resource_type).toBe(EVENT_TOPIC_RESOURCE[row.topic]);
      expect(parseEventFacts(row.topic, row.data)).toEqual(JSON.parse(row.data));
      expect(row.data).not.toMatch(/Private|1711111111|@|amount|balance|ciphertext|data_json|checkout_data/);
      return { topic: row.topic, resourceId: row.resource_id, ...JSON.parse(row.data) };
    });
  }

  function clear(): void { sqlite.exec("DELETE FROM event_outbox"); }

  it("emits fulfillment creation and void facts once while shipment metadata stays silent", () => {
    demand("fulfillment.*");
    demand("shipment.*");
    sqlite.exec(`
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type, location_id)
        VALUES ('ful_beta', 'ord_beta', 'ship', 'fulfill', 'admin', 'loc_default');
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
        VALUES ('ful_line_beta', 'ful_beta', 'ord_beta', 'item_beta', 1);
      UPDATE order_fulfillments SET status = 'voided', voided_at = unixepoch() WHERE id = 'ful_beta';
      INSERT INTO delivery_shipments (id, order_id, tracking_id, metadata)
        VALUES ('shp_beta', 'ord_beta', 'Private tracking', '{"email":"private@example.test"}');
      UPDATE delivery_shipments SET last_checked = unixepoch(), raw_status = 'Private raw';
      UPDATE delivery_shipments SET status = 'in_transit';
      UPDATE delivery_shipments SET status = 'in_transit';
    `);
    const fulfillment = {
      resourceId: "ful_beta", fulfillmentId: "ful_beta", orderId: "ord_beta", kind: "ship", locationId: "loc_default",
      lines: [{ orderItemId: "item_beta", variantId: "var_beta", quantity: 1 }],
    };
    expect(facts()).toEqual([
      { topic: "fulfillment.created", ...fulfillment },
      { topic: "fulfillment.voided", ...fulfillment },
      { topic: "shipment.updated", resourceId: "shp_beta", shipmentId: "shp_beta", orderId: "ord_beta", providerId: null, previousStatus: "pending", status: "in_transit" },
    ]);
  });

  it("emits refund facts with their lines and settles a refund from its attempts", () => {
    demand("refund.*");
    sqlite.exec(`
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor)
        VALUES ('item_beta_2', 'ord_beta', 'prod_beta', 'var_beta', 3, 500);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
        VALUES ('ord_other', 'Other Buyer', '+8801722222222', 'Other address', 'city', 'zone', 'confirmed');
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor)
        VALUES ('item_other', 'ord_other', 'prod_beta', 'var_beta', 1, 500);
      INSERT INTO order_payments (id, order_id, amount_minor, payment_method, payment_type, status, provider_ref)
        VALUES ('pay_src', 'ord_beta', 2000, 'stripe', 'full', 'succeeded', 'pi_1'),
               ('pay_src_2', 'ord_beta', 500, 'stripe', 'full', 'succeeded', 'pi_2'),
               ('pay_ref_1', 'ord_beta', 1000, 'stripe', 'refund', 'pending', NULL),
               ('pay_ref_2', 'ord_beta', 500, 'stripe', 'refund', 'pending', NULL);
      INSERT INTO order_refunds (id, order_id, currency, amount_minor) VALUES ('refund_1', 'ord_beta', 'BDT', 1500);
      INSERT INTO order_refund_lines (id, refund_id, order_id, order_item_id, quantity)
        VALUES ('rl_2', 'refund_1', 'ord_beta', 'item_beta_2', 2), ('rl_1', 'refund_1', 'ord_beta', 'item_beta', 1);
      INSERT INTO refund_attempts (id, attempt_key, refund_group_id, order_id, source_payment_id, refund_payment_id, gateway, amount_minor, reason, request_hash, provider_idempotency_key, refund_reference, allocation_index, allocation_count)
        VALUES ('ra_1', 'ak_1', 'refund_1', 'ord_beta', 'pay_src', 'pay_ref_1', 'stripe', 1000, 'Private reason', 'h', 'pk_1', 'rr_1', 0, 2),
               ('ra_2', 'ak_2', 'refund_1', 'ord_beta', 'pay_src_2', 'pay_ref_2', 'stripe', 500, 'Private reason', 'h', 'pk_2', 'rr_2', 1, 2);
    `);
    const lines = [
      { orderItemId: "item_beta", variantId: "var_beta", quantity: 1 },
      { orderItemId: "item_beta_2", variantId: "var_beta", quantity: 2 },
    ];
    expect(facts()).toEqual([{ topic: "refund.created", resourceId: "refund_1", refundId: "refund_1", orderId: "ord_beta", status: "pending", lines }]);
    clear();
    // One allocation settling leaves the refund pending; the last decides it, once.
    sqlite.exec("UPDATE refund_attempts SET status = 'refunded' WHERE id = 'ra_1'");
    expect(facts()).toEqual([]);
    sqlite.exec("UPDATE refund_attempts SET status = 'failed' WHERE id = 'ra_2'");
    expect(facts()).toEqual([{ topic: "refund.updated", resourceId: "refund_1", refundId: "refund_1", orderId: "ord_beta", previousStatus: "pending", status: "partial", lines }]);
    clear();
    // Both settled in one statement: one transition.
    sqlite.exec("UPDATE refund_attempts SET status = 'processing'; UPDATE order_refunds SET status = 'pending'");
    clear();
    sqlite.exec("UPDATE refund_attempts SET status = 'refunded'");
    expect(facts().map((fact) => [fact.topic, fact.status])).toEqual([["refund.updated", "refunded"]]);
    // A failed refund frees its lines; a live one bounds them by the line quantity.
    expect(() => sqlite.exec("INSERT INTO order_refunds (id, order_id, currency, amount_minor) VALUES ('refund_2', 'ord_beta', 'BDT', 500); INSERT INTO order_refund_lines (id, refund_id, order_id, order_item_id, quantity) VALUES ('rl_3', 'refund_2', 'ord_beta', 'item_beta_2', 2)"))
      .toThrow(/refund exceeds the line quantity/);
    expect(() => sqlite.exec("INSERT INTO order_refund_lines (id, refund_id, order_id, order_item_id, quantity) VALUES ('rl_4', 'refund_2', 'ord_beta', 'item_other', 1)"))
      .toThrow(/refund line is not a line of the refund order/);
    expect(() => sqlite.exec("UPDATE order_refund_lines SET quantity = 1 WHERE id = 'rl_2'")).toThrow(/immutable/);
    sqlite.exec("UPDATE order_refunds SET status = 'failed' WHERE id = 'refund_1'");
    sqlite.exec("INSERT INTO order_refund_lines (id, refund_id, order_id, order_item_id, quantity) VALUES ('rl_5', 'refund_2', 'ord_beta', 'item_beta_2', 3)");
  });

  it("emits payment status facts without amounts, provider references or metadata", () => {
    demand("payment.*");
    sqlite.exec(`
      INSERT INTO order_payments (id, order_id, amount_minor, payment_method, provider_ref, metadata)
        VALUES ('pay_beta', 'ord_beta', 1000, 'cod', 'Private reference', '{"phone":"+8801711111111"}');
      UPDATE order_payments SET updated_at = updated_at + 1, metadata = '{"email":"private@example.test"}';
      UPDATE order_payments SET status = 'confirmed';
      UPDATE order_payments SET status = 'confirmed';
    `);
    const payment = { topic: "payment.updated", resourceId: "pay_beta", paymentId: "pay_beta", orderId: "ord_beta", provider: "cod" };
    expect(facts()).toEqual([
      { ...payment, previousStatus: null, status: "pending" },
      { ...payment, previousStatus: "pending", status: "confirmed" },
    ]);
  });

  it("emits discount lifecycle facts for revisions, restore and deletion but not timestamps", () => {
    demand("discount.*");
    sqlite.exec(`
      INSERT INTO promotions (id, name, method) VALUES ('promo_beta', 'Private offer', 'code');
      UPDATE promotions SET updated_at = updated_at + 1;
      UPDATE promotions SET status = 'active', revision = revision + 1;
      UPDATE promotions SET deleted_at = unixepoch();
      UPDATE promotions SET deleted_at = deleted_at + 1;
      UPDATE promotions SET deleted_at = NULL, status = 'draft', revision = revision + 1;
      DELETE FROM promotions;
    `);
    expect(facts()).toEqual([
      { topic: "discount.created", resourceId: "promo_beta", promotionId: "promo_beta", previousStatus: null, status: "draft" },
      { topic: "discount.updated", resourceId: "promo_beta", promotionId: "promo_beta", previousStatus: "draft", status: "active" },
      { topic: "discount.deleted", resourceId: "promo_beta", promotionId: "promo_beta", previousStatus: "active", status: "deleted" },
      { topic: "discount.updated", resourceId: "promo_beta", promotionId: "promo_beta", previousStatus: "active", status: "draft" },
      { topic: "discount.deleted", resourceId: "promo_beta", promotionId: "promo_beta", previousStatus: "draft", status: "deleted" },
    ]);
  });

  it("emits redemption ids only after a valid allocation and rejects duplicate claims", () => {
    demand("discount.redeemed");
    sqlite.exec(`
      INSERT INTO promotions (id, name, method, status) VALUES ('promo_beta', 'Offer', 'code', 'active');
      INSERT INTO promotion_codes (id, promotion_id, code, normalized_code) VALUES ('code_beta', 'promo_beta', 'SAVE10', 'SAVE10');
      INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position)
        VALUES ('effect_beta', 'promo_beta', 'fixed_amount_off', 'order', 'once', '{"amountMinor":100,"currencyCode":"BDT"}', 0);
      INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
        evaluator_version, method, promotion_name, promotion_code, effect_kind, target, currency_code, base_amount_minor, discount_amount_minor, quantity)
        VALUES ('alloc_beta', 'ord_beta', 'item_beta', 'promo_beta', 'effect_beta', 1, 1, 'code', 'Offer', 'SAVE10', 'fixed_amount_off', 'order', 'BDT', 1000, 100, 1);
    `);
    const redeem = `INSERT INTO promotion_redemptions (id, promotion_id, order_id, customer_id, promotion_revision, promotion_code, currency_code, discount_amount_minor)
      VALUES ('red_beta', 'promo_beta', 'ord_beta', 'cus_beta', 1, 'SAVE10', 'BDT', 100)`;
    sqlite.exec(redeem);
    expect(() => sqlite.exec(redeem)).toThrow();
    expect(facts()).toEqual([{ topic: "discount.redeemed", resourceId: "promo_beta", promotionId: "promo_beta", orderId: "ord_beta", codeId: "code_beta" }]);
  });

  it("emits review creation and moderation facts without buyer text", () => {
    demand("review.*");
    sqlite.exec(`
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES ('ful_beta', 'ord_beta', 'ship', 'review', 'admin');
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES ('fln_beta', 'ful_beta', 'ord_beta', 'item_beta', 1);
      UPDATE orders SET status = 'delivered' WHERE id = 'ord_beta';
      INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, author_type, author_display_name, rating, title, body)
        VALUES ('rev_beta_00001', 'prod_beta', 'var_beta', 'ord_beta', 'item_beta', 'cus_beta', 'customer', 'Private Buyer', 4, 'Private title', 'private@example.test');
      UPDATE product_reviews SET updated_at = updated_at + 1, body = 'Private edited review';
      UPDATE product_reviews SET status = 'published', published_at = unixepoch();
      UPDATE product_reviews SET status = 'published';
      UPDATE product_reviews SET status = 'withdrawn';
    `);
    const review = { resourceId: "rev_beta_00001", reviewId: "rev_beta_00001", productId: "prod_beta", rating: 4 };
    expect(facts()).toEqual([
      { topic: "review.created", ...review, previousStatus: null, status: "pending" },
      { topic: "review.updated", ...review, previousStatus: "pending", status: "published" },
      { topic: "review.updated", ...review, previousStatus: "published", status: "withdrawn" },
    ]);
  });

  it("emits gift card lifecycle and ledger ids without credentials, recipients or money", () => {
    demand("gift_card.*");
    demand("gift_card_transaction.*");
    sqlite.exec(`
      INSERT INTO gift_cards (id, code_hash, code_ciphertext, code_last4, currency_code, initial_amount_minor, source, recipient_email)
        VALUES ('gc_beta_00001', 'Private hash', 'Private ciphertext', '1234', 'BDT', 1000, 'manual', 'private@example.test');
      INSERT INTO gift_card_transactions (id, gift_card_id, kind, amount_minor, balance_after_minor, idempotency_key, actor_type)
        VALUES ('gct_beta_00001', 'gc_beta_00001', 'issue', 1000, 1000, 'issue:beta', 'admin');
      UPDATE gift_cards SET note = 'Private note', updated_at = updated_at + 1;
      UPDATE gift_cards SET status = 'disabled';
      UPDATE gift_cards SET status = 'disabled';
    `);
    expect(facts()).toEqual([
      { topic: "gift_card.created", resourceId: "gc_beta_00001", giftCardId: "gc_beta_00001", previousStatus: null, status: "active" },
      { topic: "gift_card_transaction.created", resourceId: "gct_beta_00001", giftCardId: "gc_beta_00001", transactionId: "gct_beta_00001", kind: "issue", orderId: null },
      { topic: "gift_card.updated", resourceId: "gc_beta_00001", giftCardId: "gc_beta_00001", previousStatus: "active", status: "disabled" },
    ]);
  });

  it("marks abandonment once and obeys exact-topic, family and removed demand", () => {
    sqlite.exec(`INSERT INTO abandoned_checkouts (id, checkout_id, customer_phone, checkout_data)
      VALUES ('ab_beta', 'checkout_beta', '+8801711111111', '{"email":"private@example.test"}');
      UPDATE abandoned_checkouts SET abandoned_at = 1`);
    expect(facts()).toEqual([]);
    demand("payment.updated");
    sqlite.exec("UPDATE abandoned_checkouts SET abandoned_at = NULL; UPDATE abandoned_checkouts SET abandoned_at = 2");
    expect(facts()).toEqual([]);
    demand("checkout.abandoned");
    sqlite.exec("UPDATE abandoned_checkouts SET abandoned_at = NULL; UPDATE abandoned_checkouts SET abandoned_at = 3; UPDATE abandoned_checkouts SET abandoned_at = 4, updated_at = updated_at + 1");
    const abandoned = { topic: "checkout.abandoned", resourceId: "ab_beta", abandonedCheckoutId: "ab_beta", checkoutId: "checkout_beta" };
    expect(facts()).toEqual([abandoned]);
    clear();
    sqlite.exec("DELETE FROM event_demand; UPDATE abandoned_checkouts SET abandoned_at = NULL; UPDATE abandoned_checkouts SET abandoned_at = 5");
    expect(facts()).toEqual([]);
    demand("checkout.*");
    sqlite.exec("UPDATE abandoned_checkouts SET abandoned_at = NULL; UPDATE abandoned_checkouts SET abandoned_at = 6");
    expect(facts()).toEqual([abandoned]);
  });

  it("requires object event opt-in and a revision change; rollback leaves no event or record", () => {
    demand("*");
    sqlite.exec(`
      INSERT INTO object_types (id, namespace, type, name, fields_json) VALUES ('oty_custom.beta', 'custom', 'beta', 'Beta', '[]');
      INSERT INTO object_records (type_id, id, data_json) VALUES ('oty_custom.beta', 'private', '{"email":"private@example.test"}');
      UPDATE object_records SET revision = 2;
      DELETE FROM object_records;
    `);
    expect(facts()).toEqual([]);
    sqlite.exec("BEGIN");
    sqlite.exec("INSERT INTO object_records (type_id, id, data_json, ev) VALUES ('oty_custom.beta', 'rolled_back', '{}', 1)");
    expect(facts()).toHaveLength(1);
    sqlite.exec("ROLLBACK");
    expect(facts()).toEqual([]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM object_records").get()).toEqual({ n: 0 });
    sqlite.exec(`
      INSERT INTO object_records (type_id, id, data_json, ev) VALUES ('oty_custom.beta', 'visible', '{"email":"private@example.test"}', 1);
      UPDATE object_records SET updated_at = updated_at + 1, k1 = 'ab';
      UPDATE object_records SET revision = 2, status = 'draft';
      DELETE FROM object_records;
    `);
    const object = { resourceId: "visible", objectType: "oty_custom.beta", objectId: "visible" };
    expect(facts()).toEqual([
      { topic: "object.created", ...object, revision: 1, status: "active" },
      { topic: "object.updated", ...object, revision: 2, status: "draft" },
      { topic: "object.deleted", ...object, revision: 2, status: "deleted" },
    ]);
  });
});
