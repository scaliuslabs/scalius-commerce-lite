// Customer erasure (final audit I10): after `eraseCustomer` no row of any
// table holds the buyer's name, phone, email, street or words, while their
// orders, lines and money stay; another buyer's data is untouched; and the
// one event is `customer.erased`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERASED_TEXT } from "@scalius/shared/customer-erasure";
import { REVIEW_FALLBACK_DISPLAY_NAME } from "@scalius/shared/reviews";
import { createReviewStore, type ReviewStore } from "../reviews/testing/fixture";
import { eraseCustomer } from "./customer-erasure";
import { restoreCustomer } from "./customers.service";

/** Everything that identifies Abdur Rahim (acct_rahim) and his merged guest record. */
const PII = ["Abdur Rahim", "Rahim Old", "+8801711111111", "+8801799999999", "rahim@example.test", "rahim.old@example.test", "House 1, Road 2", "Flat 9B", "my gate code is 4417", "203.0.113.7", "rahim-google-sub"];

describe("eraseCustomer", () => {
  let store: ReviewStore;
  beforeEach(() => {
    store = createReviewStore();
    const { sqlite } = store;
    sqlite.exec(`
      INSERT INTO event_demand (filter) VALUES ('customer.*'), ('order.*');
      -- A guest record merged into the account: the same person's older contact.
      INSERT INTO customers (id, name, phone, email, origin, merged_into_customer_id, deleted_at)
        VALUES ('cus_old', 'Rahim Old', '+8801799999999', 'rahim.old@example.test', 'order', 'acct_rahim', 1780000000);
      INSERT INTO customer_history (id, customer_id, name, email, phone, change_type)
        VALUES ('hist_1', 'acct_rahim', 'Abdur Rahim', 'rahim@example.test', '+8801711111111', 'created'),
               ('hist_2', 'cus_old', 'Rahim Old', NULL, '+8801799999999', 'created');
      INSERT INTO customer_addresses (id, customer_id, is_default, country_code, name, line1, line2, city, zone, phone_e164)
        VALUES ('caddr_x1', 'acct_rahim', 1, 'BD', 'Abdur Rahim', 'House 1, Road 2', 'Flat 9B', 'c', 'z', '+8801711111111');
      INSERT INTO customer_identities (provider_id, subject, customer_id) VALUES ('acme.login:google', 'rahim-google-sub', 'acct_rahim');
      INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES ('sess_hash_1', 'acct_rahim', 1900000000);
      INSERT INTO customer_marketing_consents (customer_id, channel, state, contact, source, actor, subscribed_at)
        VALUES ('acct_rahim', 'email', 'subscribed', 'rahim@example.test', 'checkout', 'buyer', 1780000000);
      INSERT INTO plugin_customer_roles (plugin_id, customer_id, role) VALUES ('acme.b2b', 'acct_rahim', 'buyer');
    `);
    store.deliveredOrder("ord_rahim", [{ item: "item_rahim", product: "prod_shirt" }]);
    sqlite.exec(`
      UPDATE orders SET notes = 'my gate code is 4417', billing_name = 'Abdur Rahim', billing_address = 'House 1, Road 2',
        billing_country_code = 'BD', shipping_address_line2 = 'Flat 9B', customer_whatsapp = '+8801711111111'
        WHERE id = 'ord_rahim';
      INSERT INTO order_tracking_signals (order_id, consent_analytics, consent_marketing, consent_sale_of_data, consent_source, client_ip, user_agent)
        VALUES ('ord_rahim', 1, 1, 0, 'banner', '203.0.113.7', 'Mozilla/5.0');
      INSERT INTO abandoned_checkouts (id, checkout_id, customer_phone, checkout_data)
        VALUES ('ab_1', 'chk_unrelated', '+8801711111111', '{"name":"Abdur Rahim","address":"House 1, Road 2"}');
      INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, customer_id, author_type, author_display_name, rating, body, status, published_at)
        VALUES ('rev_rahim_00001', 'prod_shirt', 'var_shirt', 'ord_rahim', 'item_rahim', 'acct_rahim', 'acct_rahim', 'customer', 'Abdur Rahim', 5, 'Lovely linen', 'published', 1780000000);
      INSERT INTO conversations (id, subject_type, order_id) VALUES ('cnv_rahim_order', 'order', 'ord_rahim');
      UPDATE conversations SET last_seq = 1 WHERE id = 'cnv_rahim_order';
      INSERT INTO conversation_messages (id, conversation_id, seq, kind, visibility, author_type, author_customer_id, body)
        VALUES ('msg_rahim_000001', 'cnv_rahim_order', 1, 'message', 'public', 'customer', 'acct_rahim', 'Deliver to House 1, Road 2, my gate code is 4417');
      UPDATE conversations SET last_seq = 2 WHERE id = 'cnv_rahim_order';
      INSERT INTO conversation_messages (id, conversation_id, seq, kind, visibility, author_type, author_user_id, body)
        VALUES ('msg_staff_000002', 'cnv_rahim_order', 2, 'message', 'public', 'staff', 'staff_1', 'On its way tomorrow.');
      INSERT INTO conversation_search_terms (conversation_id, message_id, seq, term)
        VALUES ('cnv_rahim_order', 'msg_rahim_000001', 1, 'gate'), ('cnv_rahim_order', 'msg_staff_000002', 2, 'tomorrow');
      INSERT INTO conversations (id, subject_type, customer_id, subject) VALUES ('cnv_rahim_store', 'store', 'acct_rahim', 'Abdur Rahim asks about sizes');
      INSERT INTO conversation_attachments (id, conversation_id, uploader_type, uploader_ref, r2_key, size_bytes, sha256)
        VALUES ('att_rahim_00001', 'cnv_rahim_order', 'customer', 'acct_rahim', 'private/conversations/cnv_rahim_order/att_rahim_00001', 10, '${"a".repeat(64)}');
    `);
    // Another buyer with an order: nothing of theirs changes.
    store.deliveredOrder("ord_karim", [{ item: "item_karim", product: "prod_mug" }], { account: "acct_karim", name: "Karim Uddin" });
    sqlite.exec(`UPDATE orders SET customer_phone = '+8801722222222', customer_email = 'karim@example.test', shipping_address = 'Road 7' WHERE id = 'ord_karim'`);
    sqlite.exec("DELETE FROM event_outbox");
  });
  afterEach(() => store.close());

  function everyRow(): string {
    const tables = store.rows("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((row) => String(row.name))
      // FTS5 shadow tables keep tokenised segments, not rows; the indexed tables are checked through their source rows.
      .filter((name) => !/_fts(_|$)/.test(name));
    return tables.map((table) => JSON.stringify(store.rows(`SELECT * FROM "${table}"`))).join("\n");
  }

  it("leaves no personal data in any table and keeps the orders and money", async () => {
    const before = everyRow();
    for (const value of PII) expect(before, value).toContain(value);
    const deleted: string[][] = [];

    const result = await eraseCustomer(store.db, {
      customerId: "acct_rahim",
      actorId: "staff_1",
      files: { delete: async (keys) => { deleted.push([keys].flat()); } },
    });

    expect(result).toEqual({ customerId: "acct_rahim", erased: true, mergedRecords: 1, orders: 1, files: 1 });
    expect(deleted).toEqual([["private/conversations/cnv_rahim_order/att_rahim_00001"]]);
    const after = everyRow();
    for (const value of PII) expect(after, value).not.toContain(value);
    // D1's search indexes follow their rows: no term of the buyer is found any more (ids like ord_rahim are tokens too, so match names and phones).
    for (const fts of ["customers_fts", "orders_fts", "abandoned_checkouts_fts", "product_reviews_fts"]) {
      for (const term of ["Abdur", "8801711111111", "8801799999999"]) {
        expect(store.scalar(`SELECT count(*) FROM ${fts} WHERE ${fts} MATCH ?`, `"${term}"`), `${fts} ${term}`).toBe(0);
      }
    }

    // The order, its line and its money stay; the region stays for tax and reports.
    expect(store.rows("SELECT customer_name, customer_phone, customer_email, shipping_address, shipping_address_line2, billing_address, notes, city, zone, total_amount_minor, status FROM orders WHERE id = 'ord_rahim'"))
      .toEqual([{ customer_name: ERASED_TEXT, customer_phone: "", customer_email: null, shipping_address: ERASED_TEXT, shipping_address_line2: null, billing_address: ERASED_TEXT, notes: null, city: "c", zone: "z", total_amount_minor: 200000, status: "delivered" }]);
    expect(store.scalar("SELECT count(*) FROM order_items WHERE order_id = 'ord_rahim'")).toBe(1);
    expect(store.rows("SELECT author_display_name, body, status FROM product_reviews WHERE id = 'rev_rahim_00001'"))
      .toEqual([{ author_display_name: REVIEW_FALLBACK_DISPLAY_NAME, body: "Lovely linen", status: "published" }]);
    expect(store.rows("SELECT id, body FROM conversation_messages ORDER BY seq"))
      .toEqual([{ id: "msg_rahim_000001", body: ERASED_TEXT }, { id: "msg_staff_000002", body: "On its way tomorrow." }]);
    expect(store.rows("SELECT message_id FROM conversation_search_terms")).toEqual([{ message_id: "msg_staff_000002" }]);
    expect(store.rows("SELECT id, name, email, phone, erased_at IS NOT NULL AS erased, deleted_at IS NOT NULL AS retired FROM customers WHERE id IN ('acct_rahim', 'cus_old') ORDER BY id"))
      .toEqual([
        { id: "acct_rahim", name: ERASED_TEXT, email: null, phone: "", erased: 1, retired: 1 },
        { id: "cus_old", name: ERASED_TEXT, email: null, phone: "", erased: 1, retired: 1 },
      ]);
    expect(store.rows("SELECT change_type, actor_id FROM customer_history WHERE customer_id = 'acct_rahim' AND change_type = 'erased'"))
      .toEqual([{ change_type: "erased", actor_id: "staff_1" }]);

    // The other buyer is untouched.
    expect(store.rows("SELECT customer_name, customer_phone, shipping_address FROM orders WHERE id = 'ord_karim'"))
      .toEqual([{ customer_name: "Karim Uddin", customer_phone: "+8801722222222", shipping_address: "Road 7" }]);
    expect(store.scalar("SELECT name FROM customers WHERE id = 'acct_karim'")).toBe("Karim Uddin");

    // One customer.erased per record (ids only); no customer.updated for the scrubbed records or their deleted address book.
    const events = store.rows("SELECT topic, resource_id, data FROM event_outbox WHERE resource_type = 'customer' ORDER BY resource_id");
    expect(events).toEqual([
      { topic: "customer.erased", resource_id: "acct_rahim", data: JSON.stringify({ customerId: "acct_rahim" }) },
      { topic: "customer.erased", resource_id: "cus_old", data: JSON.stringify({ customerId: "cus_old" }) },
    ]);
  });

  it("is idempotent and the record cannot be restored", async () => {
    await eraseCustomer(store.db, { customerId: "acct_rahim", actorId: "staff_1" });
    store.sqlite.exec("DELETE FROM event_outbox");
    await expect(eraseCustomer(store.db, { customerId: "acct_rahim", actorId: "staff_1" }))
      .resolves.toEqual({ customerId: "acct_rahim", erased: false, mergedRecords: 0, orders: 0, files: 0 });
    await expect(restoreCustomer(store.db, "acct_rahim", "staff_1")).rejects.toThrow(/erased/);
    expect(store.scalar("SELECT count(*) FROM event_outbox")).toBe(0);
  });

  it("refuses while an order is still in progress, and changes nothing", async () => {
    store.order("ord_open", [{ item: "item_open", product: "prod_mug" }]);
    const before = everyRow();
    await expect(eraseCustomer(store.db, { customerId: "acct_rahim", actorId: "staff_1" })).rejects.toThrow(/in progress/);
    expect(everyRow()).toBe(before);
  });

  it("answers not found for an unknown customer", async () => {
    await expect(eraseCustomer(store.db, { customerId: "cus_missing", actorId: null })).rejects.toThrow(/not found/i);
  });
});
