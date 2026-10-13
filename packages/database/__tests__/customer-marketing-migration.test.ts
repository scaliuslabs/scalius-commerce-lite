// Migration 0108 (customers & marketing): consent with its trigger-written
// audit log and event, tags, segments, trigger-maintained order statistics,
// the promotion to segment link (cache dependencies), and the notification
// outbox/receipts rebuild that admits the `customer` subject. It applies over
// a populated 0107 database: every outbox and receipt row survives with its
// foreign key intact, and the order statistics are backfilled.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "@tursodatabase/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MARKETING_CHANNELS,
  MARKETING_CONSENT_ACTORS,
  MARKETING_CONSENT_SOURCES,
  MARKETING_CONSENT_STATES,
} from "../../shared/src/customer-marketing";
import { parseEventFacts } from "../../shared/src/events";
import { CACHE_DEP_LATER_TABLES, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import {
  MARKETING_CHANNEL_VALUES,
  MARKETING_CONSENT_ACTOR_VALUES,
  MARKETING_CONSENT_SOURCE_VALUES,
  MARKETING_CONSENT_STATE_VALUES,
} from "../src/schema/customer-marketing";
import { compiledMigrationSql, createMigratedSqlite, execOnTursoEngine } from "../src/testing/sqlite-d1";

const NAME = "0108_customer_marketing";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

function seedCustomer(db: DatabaseSync, id: string, phone: string, extra = ""): void {
  db.prepare(`INSERT INTO customers (id, name, phone${extra ? ", email" : ""}) VALUES (?, ?, ?${extra ? ", ?" : ""})`)
    .run(...[id, `Customer ${id}`, phone, ...(extra ? [extra] : [])]);
}

function seedOrder(db: DatabaseSync, id: string, values: Record<string, string | number | null>): void {
  const row: Record<string, string | number | null> = {
    id,
    customer_name: "Rahim Uddin",
    customer_phone: "+8801711111111",
    shipping_address: "House 1",
    city: "city_1",
    zone: "zone_1",
    status: "pending",
    ...values,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

type Stats = { customer_id: string; orders_count: number; total_spent_minor: number; first_order_at: number | null; last_order_at: number | null };
function stats(db: DatabaseSync, customerId: string): Omit<Stats, "customer_id"> | undefined {
  return db.prepare("SELECT orders_count, total_spent_minor, first_order_at, last_order_at FROM customer_order_stats WHERE customer_id = ?")
    .get(customerId) as Omit<Stats, "customer_id"> | undefined;
}

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(new Set(triggers.map((trigger) => trigger.table))).toEqual(new Set(["promotion_customer_segments"]));
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table))
      .toEqual(["promotion_customer_segments"]);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
  });

  it("keeps trigger bodies remote-D1 safe and transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });

  it("mirrors the shared consent vocabularies in its CHECKs", () => {
    expect([...MARKETING_CHANNEL_VALUES]).toEqual([...MARKETING_CHANNELS]);
    expect([...MARKETING_CONSENT_STATE_VALUES]).toEqual([...MARKETING_CONSENT_STATES]);
    expect([...MARKETING_CONSENT_SOURCE_VALUES]).toEqual([...MARKETING_CONSENT_SOURCES]);
    expect([...MARKETING_CONSENT_ACTOR_VALUES]).toEqual([...MARKETING_CONSENT_ACTORS]);
  });
});

describe(`${NAME} over a populated 0107 database`, () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createMigratedSqlite({ beforeMigration: "0108_" });
    seedCustomer(db, "cust_a", "+8801711111111", "A@Example.com");
    seedCustomer(db, "cust_b", "+8801722222222");
    seedCustomer(db, "cust_none", "+8801733333333");
    seedOrder(db, "ord_a1", { customer_id: "cust_a", paid_amount_minor: 50_000, created_at: 1_700_000_000 });
    seedOrder(db, "ord_a2", { customer_id: "cust_a", paid_amount_minor: 25_000, created_at: 1_710_000_000, status: "delivered" });
    // Not real orders: unfinished online payment, deleted.
    seedOrder(db, "ord_a3", { customer_id: "cust_a", paid_amount_minor: 0, created_at: 1_720_000_000, status: "incomplete" });
    seedOrder(db, "ord_a4", { customer_id: "cust_a", paid_amount_minor: 9_999, created_at: 1_730_000_000, deleted_at: 1_730_000_001 });
    seedOrder(db, "ord_b1", { customer_id: "cust_b", paid_amount_minor: 0, created_at: 1_705_000_000 });
    seedOrder(db, "ord_guest", { customer_id: null, created_at: 1_705_000_000 });
    db.exec(`
      INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, order_id, audience, notification_type, source, payload)
        VALUES ('nob_1', 'order:ord_a1:created', 'order', 'ord_a1', 'ord_a1', 'customer', 'order_created', 'checkout', '{}');
      INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, audience, notification_type, source, payload, status)
        VALUES ('nob_2', 'gift:gc_1', 'gift_card', 'gc_1', 'customer', 'gift_card_issued', 'admin', '{"x":1}', 'sent');
      INSERT INTO notification_delivery_receipts (id, receipt_key, outbox_id, subject_type, subject_id, order_id, notification_type, channel, provider, recipient_hash, status)
        VALUES ('ndr_1', 'nob_1:email:h', 'nob_1', 'order', 'ord_a1', 'ord_a1', 'order_created', 'email', 'resend', 'h', 'accepted');
      INSERT INTO notification_delivery_receipts (id, receipt_key, outbox_id, subject_type, subject_id, notification_type, channel, provider, recipient_hash)
        VALUES ('ndr_2', 'nob_2:sms:h', 'nob_2', 'gift_card', 'gc_1', 'gift_card_issued', 'sms', 'gennet', 'h');
    `);
    db.exec(compiledMigrationSql("d1", undefined, "0108_"));
  });
  afterEach(() => db.close());

  it("keeps every outbox and receipt row, their foreign key and their indexes", () => {
    expect(db.prepare("SELECT id, status, payload FROM notification_outbox ORDER BY id").all()).toEqual([
      { id: "nob_1", status: "pending", payload: "{}" },
      { id: "nob_2", status: "sent", payload: '{"x":1}' },
    ]);
    expect(db.prepare("SELECT id, outbox_id, status FROM notification_delivery_receipts ORDER BY id").all()).toEqual([
      { id: "ndr_1", outbox_id: "nob_1", status: "accepted" },
      { id: "ndr_2", outbox_id: "nob_2", status: "pending" },
    ]);
    const receiptsSql = String((db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'notification_delivery_receipts'").get() as { sql: string }).sql);
    expect(receiptsSql).toMatch(/REFERENCES\s+"?notification_outbox"?/);
    expect(receiptsSql).not.toContain("__new_");
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__new_%'").get()).toEqual({ n: 0 });
    const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name IN ('notification_outbox', 'notification_delivery_receipts') AND sql IS NOT NULL").all();
    expect(indexes).toHaveLength(17);
    // The customer subject is admitted; an unknown one is still refused.
    db.exec(`INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, audience, notification_type, source, payload)
      VALUES ('nob_3', 'marketing:cust_a:optin:1', 'customer', 'cust_a', 'customer', 'marketing_opt_in', 'newsletter', '{}')`);
    db.exec(`INSERT INTO notification_delivery_receipts (id, receipt_key, outbox_id, subject_type, subject_id, notification_type, channel, provider, recipient_hash)
      VALUES ('ndr_3', 'nob_3:email:h', 'nob_3', 'customer', 'cust_a', 'marketing_opt_in', 'email', 'mailpit', 'h')`);
    expect(() => db.exec(`INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, audience, notification_type, source, payload)
      VALUES ('nob_4', 'x', 'segment', 'seg_1', 'customer', 'x', 'x', '{}')`)).toThrow(/CHECK/);
    // Receipts still cascade with their outbox row, and still need one.
    db.exec("DELETE FROM notification_outbox WHERE id = 'nob_1'");
    expect(db.prepare("SELECT id FROM notification_delivery_receipts ORDER BY id").all()).toEqual([{ id: "ndr_2" }, { id: "ndr_3" }]);
    expect(() => db.exec(`INSERT INTO notification_delivery_receipts (id, receipt_key, outbox_id, subject_type, subject_id, notification_type, channel, provider, recipient_hash)
      VALUES ('ndr_9', 'k9', 'nob_missing', 'customer', 'cust_a', 'x', 'email', 'x', 'h')`)).toThrow(/FOREIGN KEY/);
  });

  it("backfills order statistics from real orders only", () => {
    expect(stats(db, "cust_a")).toEqual({ orders_count: 2, total_spent_minor: 75_000, first_order_at: 1_700_000_000, last_order_at: 1_710_000_000 });
    expect(stats(db, "cust_b")).toEqual({ orders_count: 1, total_spent_minor: 0, first_order_at: 1_705_000_000, last_order_at: 1_705_000_000 });
    // The chain continues through 0128, which gives every customer its zero row.
    expect(stats(db, "cust_none")).toEqual({ orders_count: 0, total_spent_minor: 0, first_order_at: null, last_order_at: null });
    expect(db.prepare("SELECT count(*) AS n FROM customer_order_stats").get()).toEqual({ n: 3 });
  });

  it("keeps order statistics equal to a recomputation through every order write", () => {
    const recomputed = (customerId: string) => db.prepare(`
      SELECT count(*) AS orders_count, COALESCE(sum(max(paid_amount_minor, 0)), 0) AS total_spent_minor,
        min(created_at) AS first_order_at, max(created_at) AS last_order_at
      FROM orders WHERE customer_id = ? AND deleted_at IS NULL AND status <> 'incomplete'`).get(customerId);
    const expectConsistent = () => {
      for (const id of ["cust_a", "cust_b", "cust_none"]) {
        const expected = recomputed(id) as Omit<Stats, "customer_id">;
        const actual = stats(db, id) ?? { orders_count: 0, total_spent_minor: 0, first_order_at: null, last_order_at: null };
        expect(actual, id).toEqual(expected);
      }
    };
    seedOrder(db, "ord_n1", { customer_id: "cust_none", paid_amount_minor: 1_000, created_at: 1_740_000_000 });
    expectConsistent();
    // Paid later, online payment finishing, a refund lowering paid, trash and restore.
    db.exec("UPDATE orders SET paid_amount_minor = 5_000 WHERE id = 'ord_b1'");
    db.exec("UPDATE orders SET status = 'pending' WHERE id = 'ord_a3'");
    db.exec("UPDATE orders SET paid_amount_minor = -100 WHERE id = 'ord_a2'");
    db.exec("UPDATE orders SET deleted_at = 1 WHERE id = 'ord_a1'");
    expectConsistent();
    db.exec("UPDATE orders SET deleted_at = NULL WHERE id = 'ord_a1'");
    // An order moving to another record (verified-contact link) updates both.
    db.exec("UPDATE orders SET customer_id = 'cust_b' WHERE id = 'ord_a2'");
    expectConsistent();
    db.exec("UPDATE orders SET customer_id = NULL WHERE id = 'ord_n1'");
    db.exec("DELETE FROM orders WHERE id = 'ord_b1'");
    expectConsistent();
    // Status changes that do not cross `incomplete` change nothing and stay consistent.
    db.exec("UPDATE orders SET status = 'shipped' WHERE id = 'ord_a1'");
    expectConsistent();
    // A permanently deleted customer takes its statistics; its orders are kept.
    db.exec("DELETE FROM customers WHERE id = 'cust_b'");
    expect(stats(db, "cust_b")).toBeUndefined();
    expect(db.prepare("SELECT customer_id FROM orders WHERE id = 'ord_a2'").get()).toEqual({ customer_id: null });
  });

  it("writes one audit row and one event per consent state change", () => {
    db.exec("DELETE FROM event_outbox");
    db.exec(`INSERT INTO customer_marketing_consents (customer_id, channel, state, contact, source, actor, consent_text_version, consent_text, requested_at, confirmation_hash)
      VALUES ('cust_a', 'email', 'pending', 'a@example.com', 'newsletter', 'buyer', 'newsletter:abcdef012345', 'Get offers', 100, 'hash1')`);
    db.exec("UPDATE customer_marketing_consents SET requested_at = 200, confirmation_hash = 'hash2' WHERE customer_id = 'cust_a' AND channel = 'email'");
    db.exec(`UPDATE customer_marketing_consents SET state = 'subscribed', subscribed_at = 300, requested_at = NULL, confirmation_hash = NULL, source = 'link'
      WHERE customer_id = 'cust_a' AND channel = 'email'`);
    db.exec(`UPDATE customer_marketing_consents SET state = 'unsubscribed', unsubscribed_at = 400, source = 'admin', actor = 'staff', actor_id = 'usr_1', note = 'Asked by phone'
      WHERE customer_id = 'cust_a' AND channel = 'email'`);
    const audit = db.prepare("SELECT id, previous_state, state, source, actor, actor_id, note, contact, consent_text_version FROM customer_marketing_consent_events ORDER BY id").all();
    expect(audit).toEqual([
      { id: "mce_cust_a_email_1", previous_state: null, state: "pending", source: "newsletter", actor: "buyer", actor_id: null, note: null, contact: "a@example.com", consent_text_version: "newsletter:abcdef012345" },
      { id: "mce_cust_a_email_2", previous_state: "pending", state: "subscribed", source: "link", actor: "buyer", actor_id: null, note: null, contact: "a@example.com", consent_text_version: "newsletter:abcdef012345" },
      { id: "mce_cust_a_email_3", previous_state: "subscribed", state: "unsubscribed", source: "admin", actor: "staff", actor_id: "usr_1", note: "Asked by phone", contact: "a@example.com", consent_text_version: "newsletter:abcdef012345" },
    ]);
    const events = db.prepare("SELECT topic, resource_id, data FROM event_outbox ORDER BY rowid").all() as Array<{ topic: string; resource_id: string; data: string }>;
    expect(events.map((event) => event.topic)).toEqual(Array(3).fill("customer.consent_changed"));
    expect(events.map((event) => parseEventFacts("customer.consent_changed", event.data))).toEqual([
      { customerId: "cust_a", channel: "email", previousState: null, state: "pending", source: "newsletter" },
      { customerId: "cust_a", channel: "email", previousState: "pending", state: "subscribed", source: "link" },
      { customerId: "cust_a", channel: "email", previousState: "subscribed", state: "unsubscribed", source: "admin" },
    ]);
  });

  it("refuses consent rows that break the state machine shape", () => {
    const insert = (values: string) => () => db.exec(`INSERT INTO customer_marketing_consents (customer_id, channel, state, contact, source, actor, subscribed_at, requested_at, confirmation_hash) VALUES (${values})`);
    // Pending is e-mail double opt-in only, and always carries its confirmation.
    expect(insert("'cust_a', 'sms', 'pending', '+8801711111111', 'newsletter', 'buyer', NULL, 1, 'h'")).toThrow(/CHECK/);
    expect(insert("'cust_a', 'email', 'pending', 'a@example.com', 'newsletter', 'buyer', NULL, NULL, NULL")).toThrow(/CHECK/);
    expect(insert("'cust_a', 'email', 'subscribed', 'a@example.com', 'newsletter', 'buyer', NULL, NULL, NULL")).toThrow(/CHECK/);
    expect(insert("'cust_a', 'email', 'subscribed', 'a@example.com', 'carrier_pigeon', 'buyer', 1, NULL, NULL")).toThrow(/CHECK/);
    expect(insert("'cust_x', 'sms', 'subscribed', '+8801711111111', 'admin', 'staff', 1, NULL, NULL")).toThrow(/FOREIGN KEY/);
    insert("'cust_a', 'sms', 'subscribed', '+8801711111111', 'checkout', 'buyer', 1, NULL, NULL")();
    expect(insert("'cust_a', 'sms', 'unsubscribed', '+8801711111111', 'checkout', 'buyer', NULL, NULL, NULL")).toThrow(/UNIQUE|PRIMARY/);
    // A permanently deleted customer takes its consent and audit rows.
    db.exec("DELETE FROM customers WHERE id = 'cust_a'");
    expect(db.prepare("SELECT count(*) AS n FROM customer_marketing_consent_events").get()).toEqual({ n: 0 });
  });

  it("stores only normalised tags and segment shapes", () => {
    const tag = (value: string) => () => db.prepare("INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cust_a', ?)").run(value);
    tag("vip")();
    tag("ঢাকা পাইকারি")();
    for (const bad of ["VIP", " vip", "a  b", "a,b", "", "x".repeat(41)]) expect(tag(bad), bad).toThrow(/CHECK/);
    expect(tag("vip")).toThrow(/UNIQUE|PRIMARY/);
    const segment = (id: string, name: string, definition = '{"version":1,"match":"all","conditions":[]}') => () =>
      db.prepare("INSERT INTO customer_segments (id, name, definition) VALUES (?, ?, ?)").run(id, name, definition);
    segment("seg_vip001", "VIP")();
    expect(segment("seg_vip002", "vip")).toThrow(/UNIQUE/);
    expect(segment("bad_vip003", "Other")).toThrow(/CHECK/);
    expect(segment("seg_vip004", "Other", "[]")).toThrow(/CHECK/);
    db.exec("UPDATE customer_segments SET deleted_at = 1 WHERE id = 'seg_vip001'");
    segment("seg_vip002", "vip")();
  });

  it("links promotions to segments, advances promotion cache keys and never orphans a link", () => {
    db.exec(`INSERT INTO promotions (id, name, method, status) VALUES ('promo_1', 'VIP', 'automatic', 'draft');
      INSERT INTO customer_segments (id, name, definition) VALUES ('seg_vip001', 'VIP', '{"version":1,"match":"all","conditions":[]}');`);
    const before = db.prepare("SELECT dep, seq FROM cache_dep WHERE dep IN ('promo:promo_1', 'promo:*')").all();
    db.exec("INSERT INTO promotion_customer_segments (promotion_id, segment_id) VALUES ('promo_1', 'seg_vip001')");
    const after = db.prepare("SELECT dep, seq FROM cache_dep WHERE dep IN ('promo:promo_1', 'promo:*') ORDER BY dep").all() as Array<{ dep: string; seq: number }>;
    expect(after.map((row) => row.dep)).toEqual(["promo:*", "promo:promo_1"]);
    expect(after).not.toEqual(before);
    expect(() => db.exec("DELETE FROM customer_segments WHERE id = 'seg_vip001'")).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM promotions WHERE id = 'promo_1'");
    expect(db.prepare("SELECT count(*) AS n FROM promotion_customer_segments").get()).toEqual({ n: 0 });
  });
});

describe(`${NAME} on the Turso engine`, () => {
  it("applies every 0108 statement and maintains statistics and the consent log", async () => {
    const database = await connect(":memory:");
    const own = new Set(compiledMigrationSql("turso", undefined, `${NAME}.sql`).split(BREAKPOINT).map((statement) => statement.trim()));
    for (const statement of compiledMigrationSql("turso").split(BREAKPOINT)) {
      if (!statement.trim()) continue;
      try {
        await execOnTursoEngine(database, statement);
      } catch (error) {
        // Two pre-0100 backfills use SQL the local engine does not parse yet.
        if (own.has(statement.trim())) throw error;
      }
    }
    await database.exec("INSERT INTO customers (id, name, phone) VALUES ('cust_t', 'T', '+8801711111111')");
    await database.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, customer_id, paid_amount_minor, created_at)
      VALUES ('ord_t', 'A', '+8801711111111', 'House', 'city', 'zone', 'pending', 'cust_t', 700, 1700000000)`);
    await database.exec("UPDATE orders SET paid_amount_minor = 900 WHERE id = 'ord_t'");
    expect(await database.prepare("SELECT orders_count, total_spent_minor FROM customer_order_stats WHERE customer_id = 'cust_t'").get())
      .toEqual({ orders_count: 1, total_spent_minor: 900 });
    await database.exec(`INSERT INTO customer_marketing_consents (customer_id, channel, state, contact, source, actor, subscribed_at)
      VALUES ('cust_t', 'sms', 'subscribed', '+8801711111111', 'checkout', 'buyer', 1)`);
    expect(await database.prepare("SELECT id, state FROM customer_marketing_consent_events").all())
      .toEqual([{ id: "mce_cust_t_sms_1", state: "subscribed" }]);
    await database.close();
  }, 120_000);
});
