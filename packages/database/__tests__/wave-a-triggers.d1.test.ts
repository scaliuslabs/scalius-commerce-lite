// Wave A schema guards (0083-0086) exercised with raw SQL against the real
// migration chain: the fulfilment ledger (F1-F5), the address rule, the
// return-trigger rewrite, the line-properties snapshot (P4), conversation
// sequences (C3), attachments, the generic outbox, and the 0083 backfill.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

type Row = Record<string, SQLInputValue>;

function inserter(sqlite: DatabaseSync) {
  return (table: string, row: Row) => {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...Object.values(row));
  };
}

function one(sqlite: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

function scalar(sqlite: DatabaseSync, sql: string, ...params: SQLInputValue[]): unknown {
  const row = one(sqlite, sql, ...params);
  return row ? Object.values(row)[0] : undefined;
}

/** A migrated store with one order and three lines of different types. */
function store() {
  const sqlite = createMigratedSqlite();
  sqlite.exec("PRAGMA foreign_keys = OFF"); // parents are irrelevant to these guards
  const insert = inserter(sqlite);
  insert("orders", {
    id: "ord_1", customer_name: "Buyer", customer_phone: "01700000000",
    shipping_address: "House 1, Road 2", city: "c", zone: "z", total_amount_minor: 60_000,
  });
  const item = (id: string, type: string, quantity: number) => insert("order_items", {
    id, order_id: "ord_1", product_id: "prod_1", variant_id: `var_${id}`, quantity,
    unit_price_minor: 10_000, fulfillment_type: type,
  });
  item("item_ship", "ship", 3);
  item("item_service", "service", 1);
  item("item_digital", "digital", 2);
  const fulfil = (id: string, kind: string, lines: Array<[string, number]>, orderId = "ord_1") => {
    insert("order_fulfillments", {
      id, order_id: orderId, kind, request_key: `key_${id}`, actor_type: "admin", actor_id: "user_1",
    });
    lines.forEach(([itemId, quantity], index) => insert("order_fulfillment_lines", {
      id: `${id}_line_${index}`, fulfillment_id: id, order_id: orderId, order_item_id: itemId, quantity,
    }));
  };
  const fulfilled = (itemId: string) =>
    Number(scalar(sqlite, "SELECT fulfilled_quantity FROM order_items WHERE id = ?", itemId));
  const voidFulfilment = (id: string) =>
    sqlite.prepare("UPDATE order_fulfillments SET status = 'voided', voided_at = unixepoch() WHERE id = ?").run(id);
  return { sqlite, insert, fulfil, fulfilled, voidFulfilment };
}

describe("order-line fulfilment ledger (0083)", () => {
  it("F1: fulfilled_quantity is always the sum of active ledger lines", () => {
    const { sqlite, fulfil, fulfilled, voidFulfilment } = store();
    // A deterministic walk of partial sends, voids and rejected over-sends.
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const active: string[] = [];
    for (let step = 0; step < 60; step += 1) {
      if (active.length > 0 && random() < 0.35) {
        const [id] = active.splice(Math.floor(random() * active.length), 1);
        voidFulfilment(id!);
      } else {
        const id = `ful_${step}`;
        const quantity = 1 + Math.floor(random() * 3);
        try {
          fulfil(id, "ship", [["item_ship", quantity]]);
          active.push(id);
        } catch (error) {
          expect(String(error)).toMatch(/exceeds the unfulfilled line quantity/);
        }
      }
      const ledger = Number(scalar(sqlite, `
        SELECT coalesce(sum(l.quantity), 0) FROM order_fulfillment_lines l
        JOIN order_fulfillments f ON f.id = l.fulfillment_id
        WHERE l.order_item_id = 'item_ship' AND f.status = 'active'
      `));
      expect(fulfilled("item_ship")).toBe(ledger);
      expect(ledger).toBeLessThanOrEqual(3);
    }
  });

  it("F1: a void subtracts exactly its own lines, across several order lines", () => {
    const { fulfil, fulfilled, voidFulfilment } = store();
    fulfil("ful_a", "ship", [["item_ship", 2]]);
    fulfil("ful_b", "service", [["item_service", 1]]);
    fulfil("ful_c", "ship", [["item_ship", 1]]);
    expect([fulfilled("item_ship"), fulfilled("item_service")]).toEqual([3, 1]);
    voidFulfilment("ful_a");
    expect([fulfilled("item_ship"), fulfilled("item_service")]).toEqual([1, 1]);
    fulfil("ful_d", "ship", [["item_ship", 2]]);
    expect(fulfilled("item_ship")).toBe(3);
  });

  it("F2: refuses over-fulfilment, a type mismatch, another order's line and a voided fulfilment", () => {
    const { sqlite, insert, fulfil, fulfilled, voidFulfilment } = store();
    fulfil("ful_a", "ship", [["item_ship", 2]]);
    expect(() => fulfil("ful_over", "ship", [["item_ship", 2]])).toThrow(/exceeds the unfulfilled line quantity/);
    expect(() => fulfil("ful_kind", "pickup", [["item_ship", 1]])).toThrow(/same order and type/);
    expect(() => fulfil("ful_digital", "ship", [["item_digital", 1]])).toThrow(/same order and type/);

    insert("orders", {
      id: "ord_2", customer_name: "Other", customer_phone: "01700000001",
      shipping_address: "Road 9", city: "c", zone: "z",
    });
    insert("order_fulfillments", { id: "ful_other", order_id: "ord_2", kind: "ship", request_key: "k2", actor_type: "admin" });
    expect(() => insert("order_fulfillment_lines", {
      id: "line_cross", fulfillment_id: "ful_other", order_id: "ord_2", order_item_id: "item_ship", quantity: 1,
    })).toThrow(/same order and type/);

    voidFulfilment("ful_a");
    expect(() => insert("order_fulfillment_lines", {
      id: "line_late", fulfillment_id: "ful_a", order_id: "ord_1", order_item_id: "item_ship", quantity: 1,
    })).toThrow(/same order and type/);
    insert("order_fulfillments", { id: "ful_zero", order_id: "ord_1", kind: "ship", request_key: "zero", actor_type: "admin" });
    expect(() => insert("order_fulfillment_lines", {
      id: "line_zero", fulfillment_id: "ful_zero", order_id: "ord_1", order_item_id: "item_ship", quantity: 0,
    })).toThrow(/CHECK/);
    expect(fulfilled("item_ship")).toBe(0);
    // The projection column itself can never leave 0..quantity.
    expect(() => sqlite.exec("UPDATE order_items SET fulfilled_quantity = 4 WHERE id = 'item_ship'")).toThrow(/CHECK/);
    expect(() => sqlite.exec("UPDATE order_items SET fulfilled_quantity = -1 WHERE id = 'item_ship'")).toThrow(/CHECK/);
  });

  it("F3: the ledger is append-only and a fulfilment only moves active to voided", () => {
    const { sqlite, fulfil, fulfilled, voidFulfilment } = store();
    fulfil("ful_a", "ship", [["item_ship", 2]]);
    expect(() => sqlite.exec("UPDATE order_fulfillment_lines SET quantity = 1")).toThrow(/immutable/);
    expect(() => sqlite.exec("DELETE FROM order_fulfillment_lines")).toThrow(/immutable/);
    expect(() => sqlite.exec("UPDATE order_fulfillments SET kind = 'pickup' WHERE id = 'ful_a'")).toThrow(/active to voided/);
    expect(() => sqlite.exec("UPDATE order_fulfillments SET request_key = 'other' WHERE id = 'ful_a'")).toThrow(/active to voided/);
    expect(() => sqlite.exec(
      "UPDATE order_fulfillments SET status = 'voided', voided_at = 1, cash_collected_minor = 5 WHERE id = 'ful_a'",
    )).toThrow(/active to voided/);
    expect(() => sqlite.exec("UPDATE order_fulfillments SET status = 'voided' WHERE id = 'ful_a'")).toThrow(/CHECK/);
    expect(() => sqlite.exec("DELETE FROM order_fulfillments WHERE id = 'ful_a'")).toThrow(/durable order evidence/);
    voidFulfilment("ful_a");
    expect(fulfilled("item_ship")).toBe(0);
    expect(() => voidFulfilment("ful_a")).toThrow(/active to voided/);
    expect(() => sqlite.exec("UPDATE order_fulfillments SET status = 'active', voided_at = NULL WHERE id = 'ful_a'"))
      .toThrow(/active to voided/);
    expect(fulfilled("item_ship")).toBe(0);
  });

  it("keeps one fulfilment per request key and per courier parcel", () => {
    const { insert } = store();
    insert("order_fulfillments", { id: "ful_a", order_id: "ord_1", kind: "ship", request_key: "same", actor_type: "admin", shipment_id: "shp_1" });
    expect(() => insert("order_fulfillments", { id: "ful_b", order_id: "ord_1", kind: "ship", request_key: "same", actor_type: "admin" }))
      .toThrow(/UNIQUE/);
    expect(() => insert("order_fulfillments", { id: "ful_c", order_id: "ord_1", kind: "ship", request_key: "other", actor_type: "admin", shipment_id: "shp_1" }))
      .toThrow(/UNIQUE/);
    expect(() => insert("order_fulfillments", { id: "ful_d", order_id: "ord_1", kind: "pickup", request_key: "pickup", actor_type: "admin", shipment_id: "shp_2" }))
      .toThrow(/CHECK/);
  });

  it("F4: an order that ships needs an address, city and zone; one that does not may omit them", () => {
    const { sqlite, insert } = store();
    const order = (id: string, extra: Row) => insert("orders", {
      id, customer_name: "Buyer", customer_phone: "01700000000", ...extra,
    });
    expect(() => order("ord_no_address", {})).toThrow(/shipping address required/);
    expect(() => order("ord_blank", { shipping_address: "   ", city: "c", zone: "z" })).toThrow(/shipping address required/);
    expect(() => order("ord_no_zone", { shipping_address: "Road 1", city: "c" })).toThrow(/shipping address required/);
    order("ord_pickup", {
      requires_shipping: 0, shipping_method_kind: "pickup", pickup_address: "Shop 4, Dhanmondi", pickup_hours: "10-8",
    });
    expect(one(sqlite, "SELECT shipping_address, city, zone, requires_shipping FROM orders WHERE id = 'ord_pickup'"))
      .toEqual({ shipping_address: null, city: null, zone: null, requires_shipping: 0 });
    expect(() => sqlite.exec("UPDATE orders SET requires_shipping = 1 WHERE id = 'ord_pickup'")).toThrow(/shipping address required/);
    expect(() => sqlite.exec("UPDATE orders SET city = NULL WHERE id = 'ord_1'")).toThrow(/shipping address required/);
    expect(() => order("ord_bad_kind", { requires_shipping: 0, shipping_method_kind: "drone" })).toThrow(/CHECK/);
    sqlite.exec("UPDATE orders SET notes = 'unrelated' WHERE id = 'ord_1'");
  });

  it("F5: a line's fulfilment type is frozen once written", () => {
    const { sqlite } = store();
    expect(() => sqlite.exec("UPDATE order_items SET fulfillment_type = 'pickup' WHERE id = 'item_ship'")).toThrow(/immutable/);
    sqlite.exec("UPDATE order_items SET fulfillment_type = 'ship' WHERE id = 'item_ship'");
    expect(() => inserter(sqlite)("order_items", {
      id: "item_bad", order_id: "ord_1", product_id: "p", quantity: 1, fulfillment_type: "courier",
    })).toThrow(/CHECK/);
  });

  it("F12: returns come only from handed-over ship/pickup lines, bounded by what was handed over", () => {
    const { sqlite, insert, fulfil } = store();
    insert("order_items", {
      id: "item_pickup", order_id: "ord_1", product_id: "prod_1", variant_id: "var_item_pickup", quantity: 2,
      unit_price_minor: 10_000, fulfillment_type: "pickup",
    });
    const returnCase = (id: string) => insert("order_returns", { id, order_id: "ord_1", reason: "damaged", actor_type: "admin" });
    const line = (id: string, returnId: string, itemId: string, quantity: number) => insert("order_return_lines", {
      id, return_id: returnId, order_id: "ord_1", order_item_id: itemId, variant_id: `var_${itemId}`,
      requested_quantity: quantity,
    });
    returnCase("ret_1");
    // Either guard may fire first (SQLite and PostgreSQL order triggers differently).
    expect(() => line("rl_unsent", "ret_1", "item_ship", 1)).toThrow(/shipped item|exceeds fulfilled item quantity/);
    fulfil("ful_ship", "ship", [["item_ship", 1]]);
    fulfil("ful_pickup", "pickup", [["item_pickup", 2]]);
    fulfil("ful_service", "service", [["item_service", 1]]);
    expect(() => line("rl_over", "ret_1", "item_ship", 2)).toThrow(/exceeds fulfilled item quantity/);
    line("rl_ship", "ret_1", "item_ship", 1);
    line("rl_pickup", "ret_1", "item_pickup", 2);
    expect(() => line("rl_service", "ret_1", "item_service", 1)).toThrow(/shipped item/);

    // Approving within the handed-over quantity passes; the status trigger
    // re-checks every line of the order against the same bound.
    sqlite.exec("UPDATE order_return_lines SET approved_quantity = requested_quantity WHERE return_id = 'ret_1'");
    sqlite.exec("UPDATE order_returns SET status = 'approved' WHERE id = 'ret_1'");
    returnCase("ret_2");
    expect(() => line("rl_again", "ret_2", "item_pickup", 1)).toThrow(/exceeds fulfilled item quantity/);
  });

  it("keeps lines the previous API marked shipped returnable up to their quantity until the contract migration", () => {
    const { insert } = store();
    insert("order_items", {
      id: "item_legacy", order_id: "ord_1", product_id: "prod_1", variant_id: "var_legacy", quantity: 2,
      unit_price_minor: 10_000, fulfillment_status: "shipped",
    });
    insert("order_returns", { id: "ret_1", order_id: "ord_1", reason: "damaged", actor_type: "admin" });
    const line = (id: string, quantity: number) => insert("order_return_lines", {
      id, return_id: "ret_1", order_id: "ord_1", order_item_id: "item_legacy", variant_id: "var_legacy",
      requested_quantity: quantity,
    });
    expect(() => line("rl_over", 3)).toThrow(/exceeds fulfilled item quantity/);
    line("rl_ok", 2);
  });

  it("fences in-flight checkouts when a variant's kind or a product's gift-card flag changes", () => {
    const { sqlite, insert } = store();
    insert("products", { id: "prod_x", name: "Mug", slug: "mug" });
    insert("product_variants", { id: "var_x", product_id: "prod_x", sku: "MUG-1", is_default: 1 });
    const revision = () => Number(scalar(sqlite, "SELECT revision FROM checkout_authority WHERE id = 'default'"));
    const before = revision();
    sqlite.exec("UPDATE product_variants SET fulfillment_kind = 'service' WHERE id = 'var_x'");
    expect(revision()).toBe(before + 1);
    sqlite.exec("UPDATE products SET is_gift_card = 1 WHERE id = 'prod_x'");
    expect(revision()).toBe(before + 2);
    sqlite.exec(`UPDATE products SET customization_schema = '{"version":1,"fields":[]}' WHERE id = 'prod_x'`);
    expect(revision()).toBe(before + 3);
    expect(() => sqlite.exec("UPDATE product_variants SET fulfillment_kind = 'gift_card' WHERE id = 'var_x'")).toThrow(/CHECK/);
    expect(() => sqlite.exec("UPDATE products SET customization_schema = 'not json' WHERE id = 'prod_x'")).toThrow(/CHECK/);
    expect(() => sqlite.exec(`UPDATE products SET customization_schema = '"${"x".repeat(4_100)}"' WHERE id = 'prod_x'`))
      .toThrow(/CHECK/);
  });
});

describe("line-item properties snapshot (0084)", () => {
  it("P4: a line's properties and surcharge are immutable once written", () => {
    const { sqlite, insert } = store();
    insert("order_items", {
      id: "item_custom", order_id: "ord_1", product_id: "prod_1", quantity: 1,
      unit_price_minor: 30_000, base_unit_price_minor: 10_000, properties_price_minor: 20_000,
      properties: JSON.stringify([{ key: "engraving", type: "text", label: "Engraving", value: "Nila", displayValue: "Nila", priceMinor: 20_000 }]),
    });
    expect(() => sqlite.exec(`UPDATE order_items SET properties = '[]' WHERE id = 'item_custom'`)).toThrow(/immutable/);
    expect(() => sqlite.exec("UPDATE order_items SET properties_price_minor = 0 WHERE id = 'item_custom'")).toThrow(/immutable/);
    sqlite.exec("UPDATE order_items SET discount_amount_minor = 100 WHERE id = 'item_custom'");
    expect(() => insert("order_items", {
      id: "item_bad_json", order_id: "ord_1", product_id: "prod_1", quantity: 1, properties: "{not json",
    })).toThrow(/CHECK/);
    expect(() => insert("order_items", {
      id: "item_bad_price", order_id: "ord_1", product_id: "prod_1", quantity: 1, properties_price_minor: -1,
    })).toThrow(/CHECK/);
  });
});

describe("conversations (0085)", () => {
  function thread() {
    const context = store();
    const { sqlite, insert } = context;
    insert("conversations", { id: "cnv_order00001", subject_type: "order", order_id: "ord_1" });
    let messages = 0;
    const advance = (from: number) => sqlite
      .prepare("UPDATE conversations SET last_seq = last_seq + 1, version = version + 1 WHERE id = 'cnv_order00001' AND last_seq = ?")
      .run(from).changes;
    const message = (seq: number, extra: Row = {}) => insert("conversation_messages", {
      id: `msg_${String(++messages).padStart(8, "0")}`, conversation_id: "cnv_order00001", seq, kind: "message",
      author_type: "guest_receipt", body: "Where is my parcel?", ...extra,
    });
    const post = (extra: Row = {}) => {
      const from = Number(scalar(sqlite, "SELECT last_seq FROM conversations WHERE id = 'cnv_order00001'"));
      sqlite.exec("SAVEPOINT post");
      try {
        expect(advance(from)).toBe(1);
        message(from + 1, extra);
        sqlite.exec("RELEASE post");
      } catch (error) {
        sqlite.exec("ROLLBACK TO post");
        sqlite.exec("RELEASE post");
        throw error;
      }
    };
    return { ...context, advance, message, post };
  }

  it("C3: a post advances the sequence by one and the message takes it; no gaps, no reuse", () => {
    const { sqlite, advance, message, post } = thread();
    expect(() => message(1)).toThrow(/must equal the conversation sequence/);
    post();
    post({ author_type: "staff", author_user_id: "user_1", visibility: "internal", body: "Courier called" });
    post();
    expect(sqlite.prepare("SELECT seq FROM conversation_messages ORDER BY seq").all().map((row) => row.seq)).toEqual([1, 2, 3]);
    // A second bump without the message in between is refused, so is a jump.
    expect(advance(3)).toBe(1);
    expect(() => advance(4)).toThrow(/one message at a time/);
    expect(() => sqlite.exec("UPDATE conversations SET last_seq = 9 WHERE id = 'cnv_order00001'")).toThrow(/one message at a time/);
    // A stale writer that lost the CAS cannot reuse a number.
    expect(() => message(3)).toThrow(/must equal the conversation sequence/);
    message(4);
    expect(() => message(4)).toThrow(/UNIQUE|must equal/);
  });

  it("C3: messages are append-only and idempotent by client key", () => {
    const { sqlite, post } = thread();
    post({ client_message_key: "buyer-key-1" });
    expect(() => post({ client_message_key: "buyer-key-1" })).toThrow(/UNIQUE/);
    expect(scalar(sqlite, "SELECT last_seq FROM conversations")).toBe(1);
    expect(() => sqlite.exec("UPDATE conversation_messages SET body = 'edited'")).toThrow(/append-only/);
    expect(() => sqlite.exec("DELETE FROM conversation_messages")).toThrow(/append-only/);
    expect(() => sqlite.exec("DELETE FROM conversations")).toThrow(/durable records/);
    expect(() => sqlite.exec("UPDATE conversations SET order_id = 'ord_2'")).toThrow(/subject is immutable/);
  });

  it("keeps buyer lines public and message shapes honest", () => {
    const { post } = thread();
    expect(() => post({ visibility: "internal" })).toThrow(/CHECK/);
    expect(() => post({ body: "   " })).toThrow(/CHECK/);
    expect(() => post({ body: "x".repeat(5_001) })).toThrow(/CHECK/);
    expect(() => post({ author_type: "customer" })).toThrow(/CHECK/);
    expect(() => post({ kind: "event", body: null })).toThrow(/CHECK/);
    post({ kind: "event", body: null, author_type: "system", event_kind: "case_submitted", event_data: '{"type":"return"}' });
  });

  it("keeps one thread per order, an owner on every thread, and read markers within the sequence", () => {
    const { sqlite, insert } = thread();
    expect(() => insert("conversations", { id: "cnv_order00002", subject_type: "order", order_id: "ord_1" })).toThrow(/UNIQUE/);
    expect(() => insert("conversations", { id: "cnv_store00001", subject_type: "store" })).toThrow(/CHECK/);
    expect(() => insert("conversations", { id: "bad_00000001", subject_type: "store", customer_id: "cus_1" })).toThrow(/CHECK/);
    insert("conversations", { id: "cnv_store00001", subject_type: "store", customer_id: "cus_1", subject: "Wholesale" });
    expect(() => sqlite.exec("UPDATE conversations SET staff_read_seq = 1 WHERE id = 'cnv_store00001'")).toThrow(/CHECK/);
    expect(() => sqlite.exec("UPDATE conversations SET status = 'closed' WHERE id = 'cnv_store00001'")).toThrow(/CHECK/);
    sqlite.exec("UPDATE conversations SET status = 'closed', closed_at = unixepoch() WHERE id = 'cnv_store00001'");
  });

  it("attaches an upload once, to a message of its own thread, at most three per message", () => {
    const { sqlite, insert, post } = thread();
    insert("conversations", { id: "cnv_store00001", subject_type: "store", customer_id: "cus_1" });
    post();
    const messageId = String(scalar(sqlite, "SELECT id FROM conversation_messages WHERE seq = 1"));
    const upload = (id: string, conversationId = "cnv_order00001") => insert("conversation_attachments", {
      id, conversation_id: conversationId, uploader_type: "guest_receipt", uploader_ref: "ord_1",
      r2_key: `private/conversations/${conversationId}/${id}`, size_bytes: 1_000, sha256: "a".repeat(64),
    });
    const attach = (id: string) => sqlite
      .prepare("UPDATE conversation_attachments SET message_id = ?, attached_at = unixepoch() WHERE id = ?")
      .run(messageId, id);
    for (const id of ["att_00000001", "att_00000002", "att_00000003", "att_00000004"]) upload(id);
    upload("att_elsewhere", "cnv_store00001");
    expect(() => attach("att_elsewhere")).toThrow(/at most three per message/);
    attach("att_00000001");
    attach("att_00000002");
    attach("att_00000003");
    expect(() => attach("att_00000004")).toThrow(/at most three per message/);
    expect(() => attach("att_00000001")).toThrow(/at most three per message/);
    expect(() => sqlite.exec("DELETE FROM conversation_attachments WHERE id = 'att_00000001'")).toThrow(/conversation record/);
    sqlite.exec("DELETE FROM conversation_attachments WHERE id = 'att_00000004'");
    expect(() => insert("conversation_attachments", {
      id: "att_leaky001", conversation_id: "cnv_order00001", uploader_type: "staff", uploader_ref: "user_1",
      r2_key: "public/att_leaky001", size_bytes: 1, sha256: "b".repeat(64),
    })).toThrow(/CHECK/);
    expect(() => insert("conversation_attachments", {
      id: "att_toolarge", conversation_id: "cnv_order00001", uploader_type: "staff", uploader_ref: "user_1",
      r2_key: "private/conversations/cnv_order00001/att_toolarge", size_bytes: 5_242_881, sha256: "c".repeat(64),
    })).toThrow(/CHECK/);
  });
});

describe("generic notification outbox (0086)", () => {
  it("keys every row by a subject that matches its foreign key", () => {
    const { insert } = store();
    const row = (id: string, extra: Row) => insert("notification_outbox", {
      id, dedupe_key: id, audience: "customer", notification_type: "order_ready_for_pickup",
      source: "test", payload: "{}", ...extra,
    });
    row("nob_1", { subject_type: "order", subject_id: "ord_1", order_id: "ord_1" });
    expect(() => row("nob_2", { subject_type: "order", subject_id: "ord_1" })).toThrow(/CHECK/);
    expect(() => row("nob_3", { subject_type: "conversation", subject_id: "cnv_1", order_id: "ord_1" })).toThrow(/CHECK/);
    expect(() => row("nob_4", { subject_type: "order", subject_id: "ord_1", order_id: "ord_1", audience: "everyone" })).toThrow(/CHECK/);
    expect(() => row("nob_1", { subject_type: "gift_card", subject_id: "gc_1" })).toThrow(/UNIQUE/);
    row("nob_5", { subject_type: "gift_card", subject_id: "gc_1" });
  });
});

describe("0083-0086 upgrade from an 0082 store", () => {
  it("backfills the ledger from sent units, keeps addresses, resets support cases and records the release", () => {
    const sqlite = createMigratedSqlite({ beforeMigration: "0083_" });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    const insert = inserter(sqlite);
    for (const id of ["ord_sent", "ord_partial", "ord_open"]) {
      insert("orders", {
        id, customer_name: "Buyer", customer_phone: "01700000000", shipping_address: `Address of ${id}`,
        city: "c", zone: "z", total_amount_minor: 30_000, updated_at: 1_790_000_000,
      });
    }
    const item = (id: string, orderId: string, quantity: number, shipped: number) => insert("order_items", {
      id, order_id: orderId, product_id: "prod_1", quantity, shipped_quantity: shipped,
      unit_price_minor: 10_000, fulfillment_status: shipped === quantity ? "shipped" : "pending",
    });
    item("item_sent_a", "ord_sent", 2, 2);
    item("item_sent_b", "ord_sent", 1, 1);
    item("item_partial", "ord_partial", 3, 1);
    item("item_partial_unsent", "ord_partial", 1, 0);
    item("item_open", "ord_open", 1, 0);
    insert("order_support_requests", { id: "osr_1", order_id: "ord_sent", type: "return", reason: "damaged", message: "Box was crushed" });
    insert("order_support_request_events", { id: "osre_1", request_id: "osr_1", order_id: "ord_sent", actor_type: "customer", event_type: "submitted" });

    sqlite.exec(compiledMigrationSql("d1", undefined, "0083_"));

    expect(sqlite.prepare("SELECT id, order_id, kind, status, request_key, actor_type, created_at FROM order_fulfillments ORDER BY id").all())
      .toEqual([
        { id: "ful_mig_ord_partial", order_id: "ord_partial", kind: "ship", status: "active", request_key: "migration:0083", actor_type: "system", created_at: 1_790_000_000 },
        { id: "ful_mig_ord_sent", order_id: "ord_sent", kind: "ship", status: "active", request_key: "migration:0083", actor_type: "system", created_at: 1_790_000_000 },
      ]);
    expect(sqlite.prepare("SELECT fulfillment_id, order_item_id, quantity FROM order_fulfillment_lines ORDER BY order_item_id").all())
      .toEqual([
        { fulfillment_id: "ful_mig_ord_partial", order_item_id: "item_partial", quantity: 1 },
        { fulfillment_id: "ful_mig_ord_sent", order_item_id: "item_sent_a", quantity: 2 },
        { fulfillment_id: "ful_mig_ord_sent", order_item_id: "item_sent_b", quantity: 1 },
      ]);
    expect(sqlite.prepare("SELECT id, fulfillment_type, fulfilled_quantity, shipped_quantity, base_unit_price_minor, properties, properties_price_minor FROM order_items ORDER BY id").all())
      .toEqual([
        { id: "item_open", fulfillment_type: "ship", fulfilled_quantity: 0, shipped_quantity: 0, base_unit_price_minor: 10_000, properties: null, properties_price_minor: 0 },
        { id: "item_partial", fulfillment_type: "ship", fulfilled_quantity: 1, shipped_quantity: 1, base_unit_price_minor: 10_000, properties: null, properties_price_minor: 0 },
        { id: "item_partial_unsent", fulfillment_type: "ship", fulfilled_quantity: 0, shipped_quantity: 0, base_unit_price_minor: 10_000, properties: null, properties_price_minor: 0 },
        { id: "item_sent_a", fulfillment_type: "ship", fulfilled_quantity: 2, shipped_quantity: 2, base_unit_price_minor: 10_000, properties: null, properties_price_minor: 0 },
        { id: "item_sent_b", fulfillment_type: "ship", fulfilled_quantity: 1, shipped_quantity: 1, base_unit_price_minor: 10_000, properties: null, properties_price_minor: 0 },
      ]);
    expect(sqlite.prepare("SELECT id, shipping_address, city, zone, requires_shipping, shipping_method_kind FROM orders ORDER BY id").all())
      .toEqual([
        { id: "ord_open", shipping_address: "Address of ord_open", city: "c", zone: "z", requires_shipping: 1, shipping_method_kind: null },
        { id: "ord_partial", shipping_address: "Address of ord_partial", city: "c", zone: "z", requires_shipping: 1, shipping_method_kind: null },
        { id: "ord_sent", shipping_address: "Address of ord_sent", city: "c", zone: "z", requires_shipping: 1, shipping_method_kind: null },
      ]);
    // The address columns are nullable now; the old NOT NULL copies are gone.
    const orderColumns = sqlite.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string; notnull: number }>;
    expect(orderColumns.filter((column) => ["shipping_address", "city", "zone"].includes(column.name)).map((column) => column.notnull))
      .toEqual([0, 0, 0]);
    expect(orderColumns.some((column) => column.name.startsWith("_old_"))).toBe(false);
    expect(scalar(sqlite, "SELECT count(*) FROM order_support_requests")).toBe(0);
    expect(scalar(sqlite, "SELECT count(*) FROM order_support_request_events")).toBe(0);
    expect(sqlite.prepare("SELECT version, name, source_sha256 AS sourceSha256 FROM scalius_schema_migrations WHERE version >= 83 ORDER BY version").all())
      .toEqual(CURRENT_DATABASE_SCHEMA_MIGRATIONS.filter((migration) => migration.version >= 83)
        .map(({ version, name, sourceSha256 }) => ({ version, name, sourceSha256 })));

    // The backfilled ledger is live: the partial order can send its rest, and
    // voiding the migrated fulfilment returns its units to the unsent list.
    sqlite.exec(`
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES ('ful_rest', 'ord_partial', 'ship', 'rest', 'admin');
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES ('fln_rest', 'ful_rest', 'ord_partial', 'item_partial', 2);
      UPDATE order_fulfillments SET status = 'voided', voided_at = unixepoch() WHERE id = 'ful_mig_ord_sent';
    `);
    expect(sqlite.prepare("SELECT id, fulfilled_quantity FROM order_items WHERE id IN ('item_partial', 'item_sent_a', 'item_sent_b') ORDER BY id").all())
      .toEqual([
        { id: "item_partial", fulfilled_quantity: 3 },
        { id: "item_sent_a", fulfilled_quantity: 0 },
        { id: "item_sent_b", fulfilled_quantity: 0 },
      ]);
  });
});
