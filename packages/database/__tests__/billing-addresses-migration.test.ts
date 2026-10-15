// Migration 0119 (billing addresses): the order billing snapshot, the tax
// snapshot's address source and the address book's default billing address.
// It applies over a populated 0118 store without inventing anything: an
// order placed before it has no billing address. The database then keeps one
// default billing address per customer, refuses a malformed billing country,
// and a billing change is an order.updated (ids and states only).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { supersededEventOutboxPostgresStatements, supersededEventOutboxSqliteStatements } from "../scripts/event-outbox-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0119_billing_addresses";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("adds columns only (no rebuild) and installs the generated event triggers verbatim", () => {
    const sqlite = migration();
    const postgres = migration("postgres/");
    expect(sqlite).not.toMatch(/CREATE TABLE|PRAGMA|INSERT INTO `orders`|UPDATE `orders`/i);
    expect(postgres).not.toMatch(/GLOB|PRAGMA|randomblob|CREATE TABLE/i);
    expect(supersededEventOutboxSqliteStatements(NAME)).toHaveLength(2);
    for (const statement of supersededEventOutboxSqliteStatements(NAME)) expect(sqlite, statement.split("\n")[0]).toContain(statement);
    for (const statement of supersededEventOutboxPostgresStatements(NAME)) expect(postgres, statement.split("\n")[0]).toContain(statement);
    expect(sqlite.split(BREAKPOINT)).toHaveLength(postgres.split(BREAKPOINT).length);
  });
});

function insertOrder(database: DatabaseSync, id: string, values: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    id,
    customer_name: "Rahim Uddin",
    customer_phone: "+8801711111111",
    status: "pending",
    requires_shipping: 0,
    ...values,
  };
  const columns = Object.keys(row);
  database.prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

describe(`${NAME} over a populated 0118 database`, () => {
  let db: DatabaseSync;
  afterEach(() => db.close());

  it("gives earlier orders no billing address and earlier addresses no billing default", () => {
    db = createMigratedSqlite({ beforeMigration: "0119_" });
    insertOrder(db, "ord_old");
    db.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111112');
      INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1) VALUES ('caddr_a', 'cust_1', 1, 'US', '1 Main St');
      DELETE FROM event_outbox;
    `);
    db.exec(compiledMigrationSql("d1", undefined, "0119_"));
    expect(db.prepare(`SELECT billing_same_as_shipping AS same, billing_country_code AS country, billing_address AS line1,
      billing_validation_skipped AS skipped FROM orders WHERE id = 'ord_old'`).get())
      .toEqual({ same: 0, country: null, line1: null, skipped: 0 });
    expect(db.prepare("SELECT is_default_billing AS billing FROM customer_addresses WHERE id = 'caddr_a'").get()).toEqual({ billing: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic IN ('order.updated', 'customer.updated')").get()).toEqual({ n: 0 });
  });
});

describe(`${NAME} rules`, () => {
  let db: DatabaseSync;
  afterEach(() => db.close());

  it("keeps one default billing address per customer and a billing change is an update event", () => {
    db = createMigratedSqlite();
    db.exec(`
      INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
        VALUES ('whs_billing', 'https://hooks.example.test/billing', '["customer.updated","order.updated"]', '2026-10', 'enc:test', 'test');
      INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111112');
      INSERT INTO customer_addresses (id, customer_id, country_code, line1, is_default_billing) VALUES ('caddr_a', 'cust_1', 'DE', 'Hauptstr. 1', 1);
      INSERT INTO customer_addresses (id, customer_id, country_code, line1) VALUES ('caddr_b', 'cust_1', 'DE', 'Hauptstr. 2');
    `);
    expect(() => db.exec("UPDATE customer_addresses SET is_default_billing = 1 WHERE id = 'caddr_b'")).toThrow(/UNIQUE/);
    db.exec("DELETE FROM event_outbox");
    db.exec("UPDATE customer_addresses SET is_default_billing = 0 WHERE id = 'caddr_a'");
    expect(db.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic = 'customer.updated'").get()).toEqual({ n: 1 });

    insertOrder(db, "ord_1", { billing_country_code: "DE", billing_postal_code: "10115" });
    expect(() => insertOrder(db, "ord_2", { billing_country_code: "de" })).toThrow(/CHECK/);
    expect(() => insertOrder(db, "ord_3", { billing_same_as_shipping: 2 })).toThrow(/CHECK/);
    db.exec("DELETE FROM event_outbox");
    db.exec("UPDATE orders SET billing_postal_code = '10117' WHERE id = 'ord_1'");
    const events = db.prepare("SELECT topic, data FROM event_outbox").all() as Array<{ topic: string; data: string }>;
    expect(events.map((event) => event.topic)).toEqual(["order.updated"]);
    // Ids and states only: no address in the payload.
    expect(events[0]!.data).not.toContain("10117");

    db.exec(`INSERT INTO order_tax_snapshots (order_id, currency_code, decimal_places, display_label, prices_include_tax,
      shipping_taxed, settings_version, calculation_version, destination_snapshot, rate_snapshot, address_source)
      VALUES ('ord_1', 'EUR', 2, 'VAT', 1, 0, 1, 'tax-v1', '{}', '{}', 'billing')`);
    expect(() => db.exec("UPDATE order_tax_snapshots SET address_source = 'home' WHERE order_id = 'ord_1'")).toThrow(/CHECK/);
  });
});
