import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeBatch, type Database } from "@scalius/database/client";
import { createMigratedSqlite, createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { buildVerifiedContactOrderLink } from "./customer-identity";

const EMAIL = "buyer@example.test";
const PHONE = "+8801712345678";
let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => {
  sqlite = createMigratedSqlite();
  db = createSqliteD1Database({ sqlite }).db;
});
afterEach(() => sqlite.close());

const link = (email: string | null = EMAIL, phone: string | null = null) =>
  buildVerifiedContactOrderLink(db, { customerId: "account", email, phone });
const runLink = (email: string | null = EMAIL, phone: string | null = null) =>
  safeBatch(db, link(email, phone) as unknown as Parameters<typeof safeBatch>[1]);

function customer(id: string, claimed = false, deleted = false) {
  sqlite.prepare(`INSERT INTO customers (id, name, phone, account_claimed_at, deleted_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, id, `phone_${id}`, claimed ? 100 : null, deleted ? 100 : null);
}
function order(id: string, customerId: string, options: { email?: string | null; phone?: string; deleted?: boolean; owner?: string } = {}) {
  sqlite.prepare(`INSERT INTO orders
    (id, customer_id, account_owner_customer_id, customer_name, customer_phone, customer_email,
     shipping_address, city, zone, total_amount_minor, deleted_at)
    VALUES (?, ?, ?, 'Buyer', ?, ?, 'House', 'City', 'Zone', 100, ?)`)
    .run(id, customerId, options.owner ?? null, options.phone ?? "other-phone", options.email === undefined ? EMAIL : options.email, options.deleted ? 100 : null);
}
function consent(customerId: string, time: number) {
  sqlite.prepare(`INSERT INTO customer_marketing_consents
    (customer_id, channel, state, contact, source, actor, subscribed_at, created_at, updated_at)
    VALUES (?, 'email', 'subscribed', ?, 'checkout', 'buyer', ?, ?, ?)`).run(customerId, EMAIL, time, time, time);
}

describe("verified contact link query bounds without planner statistics", () => {
  it.each(["email", "phone", "both"])("seeks candidate orders and customer IDs for %s", (method) => {
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get()).toBeUndefined();
    for (const query of link(method === "phone" ? null : EMAIL, method === "email" ? null : PHONE)) {
      const { sql, params } = query.toSQL();
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as SQLInputValue[])
        .map((row) => row.detail).join("\n");
      expect(plan).not.toMatch(/SCAN (?:orders|customers|merging_guest|customer_marketing_consents)\b|customers_dashboard_activity_idx|orders_list_updated_at_idx/);
      if (method !== "phone") expect(plan).toContain("orders_customer_email_lookup_idx");
      if (method !== "email") expect(plan).toContain("orders_customer_phone_lookup_idx");
      if (sql.includes('AS "merging_guest"')) expect(plan).toContain("SEARCH merging_guest USING INDEX sqlite_autoindex_customers_1 (id=?)");
      expect(params.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("verified contact guest merge", () => {
  it("retires every eligible guest once, retaining guests with unrelated, deleted, or owned orders", async () => {
    customer("account", true);
    customer("another_account", true);
    const guests = ["guest_a", "guest_z", "shared", "deleted_order", "owned_order", "empty", "claimed", "deleted_guest", "phone_only"];
    for (const id of guests) customer(id, id === "claimed", id === "deleted_guest");
    for (const id of guests.filter((id) => !["empty", "phone_only"].includes(id))) order(`matching_${id}`, id);
    order("duplicate_match", "guest_a");
    order("unrelated", "shared", { email: null });
    order("deleted", "deleted_order", { deleted: true });
    order("owned", "owned_order", { owner: "another_account" });
    order("unproven_phone", "phone_only", { email: null, phone: PHONE });
    consent("guest_a", 100);
    consent("guest_z", 100); // Equal timestamps deterministically prefer the greater customer ID.
    consent("shared", 300); // A surviving guest must never win the account's consent.
    const eventCount = sqlite.prepare("SELECT count(*) AS n FROM customer_marketing_consent_events").get();

    await runLink();

    expect(sqlite.prepare("SELECT id FROM customers WHERE merged_into_customer_id = 'account' ORDER BY id").all())
      .toEqual([{ id: "guest_a" }, { id: "guest_z" }]);
    expect(sqlite.prepare("SELECT id FROM orders WHERE account_owner_customer_id IS NULL ORDER BY id").all())
      .toEqual([{ id: "deleted" }, { id: "unproven_phone" }, { id: "unrelated" }]);
    expect(sqlite.prepare("SELECT customer_id FROM customer_marketing_consents ORDER BY customer_id").all())
      .toEqual([{ customer_id: "account" }, { customer_id: "guest_a" }, { customer_id: "shared" }]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM customer_marketing_consent_events").get()).toEqual(eventCount);
    expect(sqlite.prepare("SELECT count(*) AS n FROM customer_marketing_consent_events WHERE customer_id = 'account'").get()).toEqual({ n: 2 });
    expect(sqlite.prepare("SELECT account_claimed_at, deleted_at FROM customers WHERE id = 'account'").get())
      .toEqual({ account_claimed_at: 100, deleted_at: null });
  });

  it("unions two proven contacts without moving or logging the shared match twice", async () => {
    customer("account", true);
    customer("guest");
    customer("retained");
    order("by_email", "guest");
    order("by_phone", "guest", { email: null, phone: PHONE });
    order("by_both", "guest", { phone: PHONE });
    order("retained_match", "retained", { email: null, phone: PHONE });
    order("retained_unrelated", "retained", { email: null });
    await runLink(EMAIL, PHONE);
    expect(sqlite.prepare("SELECT count(*) AS n FROM orders WHERE account_owner_customer_id = 'account'").get()).toEqual({ n: 4 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM customer_history WHERE change_type = 'order_moved_in'").get()).toEqual({ n: 4 });
    expect(sqlite.prepare("SELECT merged_into_customer_id FROM customers WHERE id = 'guest'").get())
      .toEqual({ merged_into_customer_id: "account" });
    expect(sqlite.prepare("SELECT merged_into_customer_id, deleted_at FROM customers WHERE id = 'retained'").get())
      .toEqual({ merged_into_customer_id: null, deleted_at: null });
  });

  it("rolls all guest facts and history back when the final ownership write fails", async () => {
    customer("account", true);
    customer("guest");
    order("order", "guest");
    consent("guest", 100);
    sqlite.exec("INSERT INTO customer_tag_links (customer_id, tag) VALUES ('guest', 'vip')");
    const tables = ["customers", "orders", "customer_history", "customer_tag_links", "customer_marketing_consents", "customer_marketing_consent_events"];
    const snapshot = () => tables.map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    sqlite.exec(`CREATE TRIGGER reject_link BEFORE UPDATE OF account_owner_customer_id ON orders
      WHEN NEW.account_owner_customer_id = 'account' BEGIN SELECT RAISE(ABORT, 'link rejected'); END`);
    await expect(runLink()).rejects.toThrow("link rejected");
    expect(snapshot()).toEqual(before);
  });
});
