// Wave B schema guards (reviews, digital goods, gift cards, warranty)
// exercised with raw SQL against the real migration chain on both SQLite
// providers: R1-R3 and the review request, D2/D4, G1, W1-W3, the auto-fulfil
// partial index, and the expand-only upgrade from the previous schema.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA, CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

type Row = Record<string, SQLInputValue>;
const PROVIDERS = ["d1", "turso"] as const;
const FIRST_WAVE_B_MIGRATION = "0095_";

function scalar(sqlite: DatabaseSync, sql: string, ...params: SQLInputValue[]): unknown {
  const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

/** A migrated store with one order: a shipped line, a gift-card line and a service line. */
function store(provider: (typeof PROVIDERS)[number] = "d1") {
  const sqlite = createMigratedSqlite({ provider });
  sqlite.exec("PRAGMA foreign_keys = OFF"); // parents are irrelevant to these guards
  const insert = (table: string, row: Row) => {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...Object.values(row));
  };
  const order = (id: string, status = "confirmed") => insert("orders", {
    id, customer_name: "Buyer", customer_phone: "01700000000", status,
    shipping_address: "House 1, Road 2", city: "c", zone: "z", total_amount_minor: 60_000,
  });
  const item = (id: string, orderId: string, type: string, quantity = 1, extra: Row = {}) => insert("order_items", {
    id, order_id: orderId, product_id: "prod_1", variant_id: "var_1", quantity,
    unit_price_minor: 10_000, fulfillment_type: type, ...extra,
  });
  let fulfilments = 0;
  const fulfil = (orderId: string, itemId: string, kind: string, quantity = 1, createdAt?: number) => {
    fulfilments += 1;
    const id = `ful_${fulfilments}`;
    insert("order_fulfillments", {
      id, order_id: orderId, kind, request_key: `key_${id}`, actor_type: "admin",
      ...(createdAt === undefined ? {} : { created_at: createdAt }),
    });
    insert("order_fulfillment_lines", {
      id: `fln_${fulfilments}`, fulfillment_id: id, order_id: orderId, order_item_id: itemId, quantity,
    });
    return id;
  };
  const setStatus = (orderId: string, status: string) =>
    sqlite.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, orderId);
  return { sqlite, insert, order, item, fulfil, setStatus };
}

describe.each(PROVIDERS)("reviews (0095, %s)", (provider) => {
  function reviewStore() {
    const s = store(provider);
    s.order("ord_1");
    s.item("item_ship", "ord_1", "ship", 2);
    s.item("item_gift", "ord_1", "gift_card");
    s.item("item_open", "ord_1", "ship");
    s.fulfil("ord_1", "item_ship", "ship", 1);
    s.fulfil("ord_1", "item_gift", "gift_card", 1);
    let reviews = 0;
    const review = (row: Row = {}) => {
      reviews += 1;
      s.insert("product_reviews", {
        id: `rev_test_${String(reviews).padStart(4, "0")}`, product_id: "prod_1", variant_id: "var_1",
        order_id: "ord_1", order_item_id: "item_ship", reviewer_key: "cus_1", author_type: "customer",
        author_display_name: "Rahim K.", rating: 5, status: "published", published_at: 1_790_000_000,
        ...row,
      });
      return `rev_test_${String(reviews).padStart(4, "0")}`;
    };
    return { ...s, review };
  }

  it("R1: a review needs a handed-over, reviewable line of a delivered or completed order", () => {
    const { sqlite, review, setStatus } = reviewStore();
    expect(() => review()).toThrow(/review requires a fulfilled line of a delivered order/);
    setStatus("ord_1", "delivered");
    expect(() => review({ order_item_id: "item_open" })).toThrow(/fulfilled line/); // nothing handed over
    expect(() => review({ order_item_id: "item_gift" })).toThrow(/fulfilled line/); // gift cards are not reviewable
    expect(() => review({ product_id: "prod_other" })).toThrow(/fulfilled line/);
    expect(() => review({ variant_id: "var_other" })).toThrow(/fulfilled line/);
    expect(() => review({ order_id: "ord_other" })).toThrow(/fulfilled line/);
    review();
    setStatus("ord_1", "completed");
    expect(scalar(sqlite, "SELECT count(*) FROM product_reviews")).toBe(1);
  });

  it("R2: one review per line and one live review per product and buyer", () => {
    const { sqlite, review, setStatus, item, fulfil } = reviewStore();
    setStatus("ord_1", "delivered");
    const first = review();
    expect(() => review()).toThrow(/UNIQUE/);
    item("item_again", "ord_1", "ship");
    fulfil("ord_1", "item_again", "ship");
    expect(() => review({ order_item_id: "item_again", status: "pending", published_at: null })).toThrow(/UNIQUE/);
    sqlite.prepare("UPDATE product_reviews SET status = 'withdrawn' WHERE id = ?").run(first);
    review({ order_item_id: "item_again" });
    expect(() => sqlite.prepare("UPDATE product_reviews SET order_item_id = 'item_open'").run())
      .toThrow(/review identity is immutable/);
    expect(() => sqlite.prepare("UPDATE product_reviews SET status = 'rejected'").run())
      .toThrow(/CHECK constraint failed/); // rejection needs a content reason
  });

  it("R3: stats equal the published reviews across random submit, edit, moderate, withdraw and delete", () => {
    const { sqlite, insert, order, item, fulfil, setStatus } = store(provider);
    let seed = 11;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
    const ids: string[] = [];
    for (let step = 0; step < 150; step += 1) {
      const action = ids.length === 0 ? 0 : Math.floor(random() * 5);
      if (action === 0) {
        const n = String(step).padStart(4, "0");
        order(`ord_${n}`);
        item(`item_${n}`, `ord_${n}`, "ship");
        fulfil(`ord_${n}`, `item_${n}`, "ship");
        setStatus(`ord_${n}`, "delivered");
        const status = pick(["pending", "published"]);
        insert("product_reviews", {
          id: `rev_prop_${n}`, product_id: "prod_1", variant_id: "var_1", order_id: `ord_${n}`,
          order_item_id: `item_${n}`, reviewer_key: `cus_${n}`, author_type: "customer",
          author_display_name: "Buyer B.", rating: 1 + Math.floor(random() * 5), status,
          published_at: status === "published" ? 1_790_000_000 + step : null,
        });
        ids.push(`rev_prop_${n}`);
      } else {
        const id = pick(ids);
        if (action === 1) {
          sqlite.prepare("UPDATE product_reviews SET rating = ? WHERE id = ?").run(1 + Math.floor(random() * 5), id);
        } else if (action === 2) {
          sqlite.prepare("UPDATE product_reviews SET status = 'published', published_at = coalesce(published_at, 1790000000) WHERE id = ?").run(id);
        } else if (action === 3) {
          const status = pick(["rejected", "withdrawn", "pending"]);
          sqlite.prepare("UPDATE product_reviews SET status = ?, moderation_reason = CASE WHEN ? = 'rejected' THEN 'spam' ELSE moderation_reason END WHERE id = ?")
            .run(status, status, id);
        } else {
          sqlite.prepare("DELETE FROM product_reviews WHERE id = ?").run(id);
          ids.splice(ids.indexOf(id), 1);
        }
      }
      const expected = sqlite.prepare(`
        SELECT count(*) AS review_count, coalesce(sum(rating), 0) AS rating_sum,
          sum(rating = 1) AS c1, sum(rating = 2) AS c2, sum(rating = 3) AS c3, sum(rating = 4) AS c4, sum(rating = 5) AS c5
        FROM product_reviews WHERE product_id = 'prod_1' AND status = 'published'
      `).get() as Record<string, number | null>;
      const stats = sqlite.prepare("SELECT * FROM product_review_stats WHERE product_id = 'prod_1'").get() as Record<string, number | null>;
      const count = expected.review_count!;
      const sum = expected.rating_sum!;
      expect({
        count: stats.review_count, sum: stats.rating_sum,
        histogram: [stats.count_1, stats.count_2, stats.count_3, stats.count_4, stats.count_5],
        average: stats.rating_avg_centi, rank: stats.rating_rank_milli,
      }).toEqual({
        count, sum,
        histogram: [expected.c1 ?? 0, expected.c2 ?? 0, expected.c3 ?? 0, expected.c4 ?? 0, expected.c5 ?? 0],
        average: count === 0 ? null : Math.floor((sum * 100) / count),
        rank: count === 0 ? null : Math.floor(((sum + 15) * 1000) / (count + 5)),
      });
    }
  });

  it("R3: the stats row refuses counts that do not add up", () => {
    const { sqlite, review, setStatus } = reviewStore();
    setStatus("ord_1", "delivered");
    review({ rating: 4 });
    expect(() => sqlite.prepare("UPDATE product_review_stats SET review_count = 2").run()).toThrow(/CHECK constraint failed/);
    expect(() => sqlite.prepare("UPDATE product_review_stats SET count_4 = 0, count_5 = 1").run()).toThrow(/CHECK constraint failed/);
  });

  it("records one review request per delivered order, on every path to delivered", () => {
    const { sqlite, order, setStatus } = store(provider);
    order("ord_a");
    order("ord_b", "shipped");
    setStatus("ord_a", "delivered");
    setStatus("ord_a", "completed");
    setStatus("ord_a", "delivered");
    setStatus("ord_b", "cancelled");
    expect(sqlite.prepare("SELECT order_id, status FROM order_review_requests").all())
      .toEqual([{ order_id: "ord_a", status: "scheduled" }]);
    expect(String(sqlite.prepare(`
      EXPLAIN QUERY PLAN SELECT order_id FROM order_review_requests
      WHERE status = 'scheduled' AND delivered_at <= 1790000000 LIMIT 100
    `).all().map((row) => row.detail).join("\n"))).toMatch(/order_review_requests_status_delivered_idx/);
  });
});

describe.each(PROVIDERS)("digital goods (0096, %s)", (provider) => {
  function digitalStore() {
    const s = store(provider);
    s.insert("digital_assets", { id: "dga_keys_000001", product_id: "prod_1", variant_id: "var_1", kind: "licence_keys", display_name: "Licence", status: "ready" });
    for (const n of [1, 2]) {
      s.insert("digital_licence_keys", {
        id: `key_${n}`, asset_id: "dga_keys_000001", key_ciphertext: `c${n}`, key_hash: `h${n}`, key_last4: `K00${n}`, import_id: "imp_1",
      });
    }
    s.order("ord_1", "confirmed");
    s.item("item_digital", "ord_1", "digital");
    s.insert("digital_entitlements", {
      id: "ent_1", order_id: "ord_1", order_item_id: "item_digital", asset_id: "dga_keys_000001",
      kind: "licence_keys", quantity: 1, download_limit: 2,
    });
    return s;
  }

  it("D2: a key leaves available once, to assigned or revoked, and never changes again", () => {
    const { sqlite } = digitalStore();
    const assign = sqlite.prepare(`
      UPDATE digital_licence_keys SET status = 'assigned', order_item_id = 'item_digital', entitlement_id = 'ent_1', assigned_at = unixepoch()
      WHERE id IN (SELECT id FROM digital_licence_keys WHERE asset_id = 'dga_keys_000001' AND status = 'available' ORDER BY created_at, id LIMIT 1)
    `);
    expect(assign.run().changes).toBe(1);
    expect(() => sqlite.prepare("UPDATE digital_licence_keys SET status = 'available', order_item_id = NULL, entitlement_id = NULL, assigned_at = NULL WHERE id = 'key_1'").run())
      .toThrow(/only move from available/);
    expect(() => sqlite.prepare("UPDATE digital_licence_keys SET status = 'revoked', revoked_at = 1 WHERE id = 'key_1'").run())
      .toThrow(/only move from available/);
    expect(() => sqlite.prepare("UPDATE digital_licence_keys SET key_last4 = 'XXXX' WHERE id = 'key_2'").run())
      .toThrow(/only move from available/);
    expect(() => sqlite.prepare("UPDATE digital_licence_keys SET status = 'assigned' WHERE id = 'key_2'").run())
      .toThrow(/CHECK constraint failed/); // an assignment names its line and entitlement
    sqlite.prepare("UPDATE digital_licence_keys SET status = 'revoked', revoked_at = 1 WHERE id = 'key_2'").run();
    expect(() => sqlite.prepare("DELETE FROM digital_licence_keys").run()).toThrow(/durable records/);
    expect(() => sqlite.prepare("INSERT INTO digital_licence_keys (id, asset_id, key_ciphertext, key_hash, key_last4, import_id) VALUES ('key_3', 'dga_keys_000001', 'c', 'h1', 'K003', 'imp_2')").run())
      .toThrow(/UNIQUE/); // dedupe per pool by hash
  });

  it("D4: the download count never passes the snapshot limit", () => {
    const { sqlite } = digitalStore();
    const mint = sqlite.prepare(`
      UPDATE digital_entitlements SET download_count = download_count + 1, last_download_at = unixepoch()
      WHERE id = 'ent_1' AND revoked_at IS NULL AND (download_limit IS NULL OR download_count < download_limit)
    `);
    expect([mint.run().changes, mint.run().changes, mint.run().changes]).toEqual([1, 1, 0]);
    expect(() => sqlite.prepare("UPDATE digital_entitlements SET download_count = 3").run()).toThrow(/CHECK constraint failed/);
  });

  it("keeps files under the private prefix and file columns on file assets only", () => {
    const { insert } = digitalStore();
    expect(() => insert("digital_assets", {
      id: "dga_file_000001", product_id: "prod_1", kind: "file", display_name: "Book", filename: "book.pdf",
      media_type: "application/pdf", size_bytes: 10, current_r2_key: "media/book.pdf",
    })).toThrow(/CHECK constraint failed/);
    expect(() => insert("digital_assets", {
      id: "dga_keys_000002", product_id: "prod_1", kind: "licence_keys", display_name: "Keys", filename: "x.txt", media_type: "text/plain",
    })).toThrow(/CHECK constraint failed/);
    insert("digital_assets", {
      id: "dga_file_000002", product_id: "prod_1", kind: "file", display_name: "Book", filename: "book.pdf",
      media_type: "application/pdf", size_bytes: 10, current_r2_key: "private/digital/dga_file_000002/upl_1", status: "ready",
    });
  });

  it("drives the auto-fulfil sweep from a partial index of owed automatic lines", () => {
    const { sqlite, order, item, fulfil } = store(provider);
    order("ord_1");
    item("item_digital", "ord_1", "digital", 2);
    item("item_ship", "ord_1", "ship");
    fulfil("ord_1", "item_digital", "digital", 1);
    const owed = () => sqlite.prepare(`
      SELECT order_id FROM order_items INDEXED BY order_items_auto_pending_idx
      WHERE fulfillment_type IN ('digital', 'gift_card') AND fulfilled_quantity < quantity
    `).all();
    expect(owed()).toEqual([{ order_id: "ord_1" }]);
    fulfil("ord_1", "item_digital", "digital", 1);
    expect(owed()).toEqual([]);
  });
});

describe.each(PROVIDERS)("gift cards (0097, %s)", (provider) => {
  function cardStore() {
    const s = store(provider);
    let transactions = 0;
    const card = (id: string, row: Row = {}) => s.insert("gift_cards", {
      id, code_hash: `hash_${id}`, code_ciphertext: `cipher_${id}`, code_last4: "7K2Q", currency_code: "BDT",
      initial_amount_minor: 1_000, source: "manual", ...row,
    });
    const txn = (cardId: string, kind: string, amount: number, row: Row = {}) => {
      transactions += 1;
      const balance = Number(scalar(s.sqlite, "SELECT balance_minor FROM gift_cards WHERE id = ?", cardId));
      s.insert("gift_card_transactions", {
        id: `gct_test_${String(transactions).padStart(4, "0")}`, gift_card_id: cardId, kind, amount_minor: amount,
        balance_after_minor: balance + amount, idempotency_key: `${kind}:${cardId}:${transactions}`,
        actor_type: "system", reason: kind === "adjust" ? "count correction" : null, ...row,
      });
    };
    const balance = (cardId: string) => Number(scalar(s.sqlite, "SELECT balance_minor FROM gift_cards WHERE id = ?", cardId));
    return { ...s, card, txn, balance };
  }

  it("G1: a card is born empty and only its transactions move the balance", () => {
    const { sqlite, card, txn, balance } = cardStore();
    expect(() => card("gc_test_00001", { balance_minor: 500 })).toThrow(/starts at zero/);
    card("gc_test_00001");
    txn("gc_test_00001", "issue", 1_000);
    txn("gc_test_00001", "redeem", -400);
    txn("gc_test_00001", "release", 100);
    txn("gc_test_00001", "adjust", -50);
    expect(balance("gc_test_00001")).toBe(650);
    expect(() => sqlite.prepare("UPDATE gift_cards SET balance_minor = 5000").run()).toThrow(/only through transactions/);
    expect(() => sqlite.prepare("UPDATE gift_card_transactions SET amount_minor = 1").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM gift_card_transactions").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM gift_cards").run()).toThrow(/durable records/);
    expect(() => sqlite.prepare("UPDATE gift_cards SET code_hash = 'other'").run()).toThrow(/identity is immutable/);
    sqlite.prepare("UPDATE gift_cards SET status = 'disabled', expires_at = 1 WHERE id = 'gc_test_00001'").run();
  });

  it("G1: refuses an overdraft, a wrong running balance, a wrong sign and a duplicate key", () => {
    const { insert, card, txn, balance } = cardStore();
    card("gc_test_00001");
    txn("gc_test_00001", "issue", 1_000);
    expect(() => txn("gc_test_00001", "redeem", -1_001)).toThrow(/gift card balance/);
    expect(() => txn("gc_test_00001", "redeem", -1, { balance_after_minor: 0 })).toThrow(/running balance mismatch/);
    expect(() => txn("gc_test_00001", "redeem", 5)).toThrow(/CHECK constraint failed/);
    expect(() => txn("gc_test_00001", "refund", -5)).toThrow(/CHECK constraint failed/);
    expect(() => txn("gc_test_00001", "adjust", 5, { reason: null })).toThrow(/CHECK constraint failed/);
    txn("gc_test_00001", "redeem", -1_000, { idempotency_key: "redeem:ord_1:gc_test_00001" });
    expect(() => insert("gift_card_transactions", {
      id: "gct_dup_0000001", gift_card_id: "gc_test_00001", kind: "release", amount_minor: 1_000,
      balance_after_minor: 1_000, idempotency_key: "redeem:ord_1:gc_test_00001", actor_type: "system",
    })).toThrow(/UNIQUE/);
    expect(balance("gc_test_00001")).toBe(0);
  });

  it("G1: a disabled or expired card cannot be redeemed but can still be credited", () => {
    const { sqlite, card, txn, balance } = cardStore();
    card("gc_test_00001");
    txn("gc_test_00001", "issue", 1_000);
    sqlite.prepare("UPDATE gift_cards SET status = 'disabled' WHERE id = 'gc_test_00001'").run();
    expect(() => txn("gc_test_00001", "redeem", -100)).toThrow(/gift card unavailable/);
    sqlite.prepare("UPDATE gift_cards SET status = 'active', expires_at = unixepoch() - 1 WHERE id = 'gc_test_00001'").run();
    expect(() => txn("gc_test_00001", "redeem", -100)).toThrow(/gift card unavailable/);
    txn("gc_test_00001", "refund", 100);
    sqlite.prepare("UPDATE gift_cards SET expires_at = unixepoch() + 86400 WHERE id = 'gc_test_00001'").run();
    txn("gc_test_00001", "redeem", -1_100);
    expect(balance("gc_test_00001")).toBe(0);
  });

  it("issues one card per purchased unit and one per refund attempt", () => {
    const { card } = cardStore();
    card("gc_test_00001", { source: "purchase", source_order_id: "ord_1", source_order_item_id: "item_1", source_unit_index: 0 });
    expect(() => card("gc_test_00002", { source: "purchase", source_order_id: "ord_1", source_order_item_id: "item_1", source_unit_index: 0 }))
      .toThrow(/UNIQUE/);
    card("gc_test_00003", { source: "refund", source_refund_attempt_id: "rfa_1" });
    expect(() => card("gc_test_00004", { source: "refund", source_refund_attempt_id: "rfa_1" })).toThrow(/UNIQUE/);
    expect(() => card("gc_test_00005", { source: "purchase" })).toThrow(/CHECK constraint failed/);
  });
});

describe.each(PROVIDERS)("warranty (0098, %s)", (provider) => {
  const JAN_31_2026 = Date.UTC(2026, 0, 31, 10, 30) / 1000;
  function warrantyStore() {
    const s = store(provider);
    s.insert("warranty_policies", {
      id: "wrp_test_0001", name: "1 month store warranty", provider: "store", duration_value: 1,
      duration_unit: "months", replacement_days: 7, current_revision_id: "wrr_test_0001",
    });
    s.insert("warranty_policy_revisions", {
      id: "wrr_test_0001", policy_id: "wrp_test_0001", revision: 1, name: "1 month store warranty", provider: "store",
      duration_value: 1, duration_unit: "months", replacement_days: 7,
    });
    s.order("ord_1");
    s.item("item_covered", "ord_1", "ship", 3, { warranty_revision_id: "wrr_test_0001" });
    s.item("item_plain", "ord_1", "ship");
    return s;
  }

  it("W1: one warranty per handed-over line with a revision, from the handover; voided with its fulfilment", () => {
    const { sqlite, fulfil } = warrantyStore();
    const first = fulfil("ord_1", "item_covered", "ship", 2, JAN_31_2026);
    fulfil("ord_1", "item_plain", "ship", 1, JAN_31_2026);
    const second = fulfil("ord_1", "item_covered", "ship", 1, JAN_31_2026 + 86_400 * 365);
    const rows = sqlite.prepare(`
      SELECT order_item_id, fulfillment_id, quantity, starts_at, expires_at, replacement_until, voided_at
      FROM order_item_warranties ORDER BY starts_at
    `).all();
    expect(rows).toEqual([
      {
        order_item_id: "item_covered", fulfillment_id: first, quantity: 2, starts_at: JAN_31_2026,
        // SQLite month arithmetic keeps the day and overflows: Jan 31 + 1 month = Mar 3 (2026 is not a leap year).
        expires_at: Date.UTC(2026, 2, 3, 10, 30) / 1000, replacement_until: JAN_31_2026 + 7 * 86_400, voided_at: null,
      },
      expect.objectContaining({ fulfillment_id: second, quantity: 1 }),
    ]);
    sqlite.prepare("UPDATE order_fulfillments SET status = 'voided', voided_at = 1790000000 WHERE id = ?").run(first);
    expect(sqlite.prepare("SELECT fulfillment_id, voided_at FROM order_item_warranties ORDER BY starts_at").all())
      .toEqual([{ fulfillment_id: first, voided_at: 1_790_000_000 }, { fulfillment_id: second, voided_at: null }]);
  });

  it("W2: revisions are immutable and a line's revision is frozen at commit", () => {
    const { sqlite } = warrantyStore();
    expect(() => sqlite.prepare("UPDATE warranty_policy_revisions SET duration_value = 2").run()).toThrow(/immutable/);
    expect(() => sqlite.prepare("DELETE FROM warranty_policy_revisions").run()).toThrow(/immutable/);
    expect(() => sqlite.prepare("UPDATE order_items SET warranty_revision_id = NULL WHERE id = 'item_covered'").run())
      .toThrow(/frozen at commit/);
    sqlite.prepare("UPDATE order_items SET product_name = 'Renamed' WHERE id = 'item_covered'").run();
  });

  it("W3: expiry follows SQLite calendar arithmetic for days, months and years", () => {
    const { sqlite } = warrantyStore();
    const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
    const expiry = (start: number, modifier: string) =>
      Number(scalar(sqlite, "SELECT unixepoch(?, 'unixepoch', ?)", start, modifier));
    expect(expiry(at("2024-02-29"), "+1 years")).toBe(at("2025-03-01"));
    expect(expiry(at("2024-01-31"), "+1 months")).toBe(at("2024-03-02"));
    expect(expiry(at("2025-12-31"), "+2 months")).toBe(at("2026-03-03"));
    expect(expiry(at("2025-12-31"), "+7 days")).toBe(at("2026-01-07"));
  });

  it("keeps one open claim per warranty", () => {
    const { insert, fulfil } = warrantyStore();
    fulfil("ord_1", "item_covered", "ship", 1, JAN_31_2026);
    const claim = (id: string, conversation: string, status = "open") => insert("warranty_claims", {
      id, warranty_id: "wty_fln_1", order_id: "ord_1", order_item_id: "item_covered", conversation_id: conversation,
      status, opened_by: "customer", ...(status === "resolved" ? { resolution: "repair", closed_at: 1 } : {}),
    });
    claim("wcl_test_0001", "cnv_1");
    expect(() => claim("wcl_test_0002", "cnv_2")).toThrow(/UNIQUE/);
    claim("wcl_test_0003", "cnv_3", "resolved");
    expect(() => claim("wcl_test_0004", "cnv_1", "resolved")).toThrow(/UNIQUE/); // one claim per thread
  });
});

describe.each(PROVIDERS)("expand-only upgrade from 0094 (%s)", (provider) => {
  it("keeps every row, lets the previous API's writes through and records the release", () => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: FIRST_WAVE_B_MIGRATION });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, status)
      VALUES ('ord_old', 'Buyer', '01700000000', 'House 1', 'c', 'z', 10000, 'shipped');
      INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor) VALUES ('item_old', 'ord_old', 'prod_1', 1, 10000);
    `);
    sqlite.exec(compiledMigrationSql(provider, undefined, FIRST_WAVE_B_MIGRATION));

    // The previous API's statements name no Wave B column and still work.
    sqlite.exec(`
      INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor) VALUES ('item_new', 'ord_old', 'prod_1', 1, 10000);
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES ('ful_old', 'ord_old', 'ship', 'send', 'admin');
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES ('fln_old', 'ful_old', 'ord_old', 'item_old', 1);
      UPDATE orders SET status = 'delivered' WHERE id = 'ord_old';
    `);
    expect(scalar(sqlite, "SELECT count(*) FROM order_items WHERE warranty_revision_id IS NULL")).toBe(2);
    expect(scalar(sqlite, "SELECT count(*) FROM order_item_warranties")).toBe(0);
    expect(scalar(sqlite, "SELECT count(*) FROM order_review_requests")).toBe(1);
    const releases = sqlite.prepare("SELECT version, name FROM scalius_schema_migrations WHERE version >= 93 ORDER BY version").all();
    expect(releases).toEqual([
      { version: 93, name: "0093_theme_document_v5" },
      { version: 94, name: "0094_media_rendition_ladder" },
      { version: 95, name: "0095_reviews" },
      { version: 96, name: "0096_digital_goods" },
      { version: 97, name: "0097_gift_cards" },
      { version: 98, name: "0098_warranty" },
      { version: 99, name: "0099_customer_whatsapp" },
      { version: 100, name: "0100_cache_dependencies" },
      ...CURRENT_DATABASE_SCHEMA_MIGRATIONS.filter(({ version }) => version > 100)
        .map(({ version, name }) => ({ version, name })),
    ]);
    expect(releases.at(-1)).toEqual(CURRENT_DATABASE_SCHEMA);
  });
});
