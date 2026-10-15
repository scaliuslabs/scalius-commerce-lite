// Migration 0113 (Markets step 3a, country-aware addresses): the order
// shipping-address snapshot, the customer address book and the per-country
// shipping-address trigger. It applies over a populated 0112 store: every
// shipped order becomes a Bangladesh address with its city and thana names as
// locality and dependent locality, each embedded customer address moves into
// the address book as the default, and the old customer columns are gone. The
// database then refuses a shipped order that breaks its country's rule, a
// second default address, and the delivery adapter outside Bangladesh; a
// guest record learns its first shipping address from its order.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SHIPPING_ADDRESS_TRIGGER_MIGRATION,
  requiredCountryList,
  shippingAddressPostgresStatements,
  shippingAddressSqliteStatements,
} from "../scripts/shipping-address-triggers";
import { countriesRequiringAddressField } from "../../shared/src/address-metadata";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0113_country_aware_addresses";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated per-country triggers verbatim on every provider", () => {
    expect(SHIPPING_ADDRESS_TRIGGER_MIGRATION).toBe(NAME);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const statement of shippingAddressSqliteStatements()) expect(sqlite, statement.split("\n")[0]).toContain(statement);
    for (const statement of shippingAddressPostgresStatements()) expect(postgres, statement.split("\n")[0]).toContain(statement);
  });

  it("derives the trigger's country lists from the libaddressinput rules (Bangladesh has its own branch)", () => {
    const listed = (field: Parameters<typeof requiredCountryList>[0]) => {
      const { list, listed: isRequiredList } = requiredCountryList(field);
      return { codes: list.split("|").filter(Boolean), isRequiredList };
    };
    const postal = listed("postalCode");
    expect(postal.isRequiredList).toBe(true);
    expect(postal.codes).toEqual(countriesRequiringAddressField("postalCode").filter((code) => code !== "BD"));
    const locality = listed("locality");
    // Most countries require a city: the trigger lists the exceptions instead.
    expect(locality.isRequiredList).toBe(false);
    expect(locality.codes).toContain("SG");
    expect(locality.codes).not.toContain("BD");
  });

  it("keeps every statement remote-D1 safe and transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/\bCASE\b/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
    expect(sqlite.split(BREAKPOINT)).toHaveLength(migration("postgres/").split(BREAKPOINT).length);
  });
});

function insertOrder(database: DatabaseSync, id: string, values: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    id,
    customer_name: "Rahim Uddin",
    customer_phone: "+8801711111111",
    status: "pending",
    ...values,
  };
  const columns = Object.keys(row);
  database.prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

describe(`${NAME} over a populated 0112 database`, () => {
  let db: DatabaseSync;
  afterEach(() => db.close());

  function migrate(seed: (database: DatabaseSync) => void): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0113_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0113_"));
    return db;
  }

  it("backfills every shipped order as a Bangladesh address and leaves the rest without one", () => {
    migrate((database) => {
      database.exec(`
        INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata) VALUES ('c1', 'Dhaka', 'city', NULL, '{}', '{}'), ('z1', 'Dhanmondi', 'zone', 'c1', '{}', '{}');
      `);
      insertOrder(database, "ord_ship", { shipping_address: "House 1, Road 2", city: "c1", zone: "z1", city_name: "Dhaka", zone_name: "Dhanmondi", area_name: "Road 27" });
      // An older row without names reads them from its delivery locations.
      insertOrder(database, "ord_old", { shipping_address: "House 9", city: "c1", zone: "z1" });
      insertOrder(database, "ord_pickup", { requires_shipping: 0, shipping_method_kind: "pickup" });
    });
    const row = (id: string) => db.prepare(`SELECT shipping_country_code AS country, shipping_locality AS locality,
      shipping_dependent_locality AS dependent, shipping_admin_area AS admin, shipping_postal_code AS postal,
      shipping_validation_skipped AS skipped, market_id AS market FROM orders WHERE id = ?`).get(id);
    expect(row("ord_ship")).toEqual({ country: "BD", locality: "Dhaka", dependent: "Dhanmondi", admin: null, postal: null, skipped: 0, market: null });
    expect(row("ord_old")).toMatchObject({ country: "BD", locality: "Dhaka", dependent: "Dhanmondi" });
    expect(row("ord_pickup")).toMatchObject({ country: null, locality: null });
    // The backfill writes no event and leaves the market alone (a raw row counts as the backup market).
    expect(db.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic = 'order.updated'").get()).toEqual({ n: 0 });
  });

  it("moves each embedded customer address into the address book as the default and drops the columns", () => {
    migrate((database) => {
      database.exec(`
        INSERT INTO customers (id, name, phone, address, city, zone, area, city_name, zone_name, area_name)
        VALUES ('cust_full', 'Karim', '+8801711111112', 'House 3', 'c1', 'z1', 'a1', 'Dhaka', 'Dhanmondi', 'Road 27'),
               ('cust_text', 'Sumi', '+8801711111113', 'Somewhere near the mosque', NULL, NULL, NULL, NULL, NULL, NULL),
               ('cust_none', 'Nila', '+8801711111114', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
        INSERT INTO customer_history (id, customer_id, name, phone, address, change_type) VALUES ('hist_1', 'cust_full', 'Karim', '+8801711111112', 'House 3', 'created');
      `);
    });
    const book = db.prepare(`SELECT customer_id, is_default, country_code, line1, locality, dependent_locality, admin_area,
      city, zone, area, city_name, zone_name, area_name, validation_skipped FROM customer_addresses ORDER BY customer_id`).all();
    expect(book).toEqual([
      {
        customer_id: "cust_full", is_default: 1, country_code: "BD", line1: "House 3", locality: "Dhaka", dependent_locality: "Dhanmondi",
        admin_area: null, city: "c1", zone: "z1", area: "a1", city_name: "Dhaka", zone_name: "Dhanmondi", area_name: "Road 27", validation_skipped: 0,
      },
      {
        customer_id: "cust_text", is_default: 1, country_code: "BD", line1: "Somewhere near the mosque", locality: null, dependent_locality: null,
        admin_area: null, city: null, zone: null, area: null, city_name: null, zone_name: null, area_name: null, validation_skipped: 1,
      },
    ]);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    for (const table of ["customers", "customer_history"]) {
      for (const gone of ["address", "city", "zone", "area", "city_name", "zone_name", "area_name"]) expect(columns(table)).not.toContain(gone);
    }
    // Moving the addresses is not a customer change.
    expect(db.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic = 'customer.updated'").get()).toEqual({ n: 0 });
  });
});

describe(`${NAME} rules`, () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = createMigratedSqlite();
    db.exec(`INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
      VALUES ('whs_addresses', 'https://hooks.example.test/addresses', '["customer.updated"]', '2026-10', 'enc:test', 'test')`);
  });
  afterEach(() => db.close());

  const refused = (fn: () => void) => expect(fn).toThrow(/shipping address required/);

  it("needs Bangladesh's city and thana, as before", () => {
    refused(() => insertOrder(db, "o1", { shipping_address: "House 1", shipping_country_code: "BD", city: "c1" }));
    insertOrder(db, "o2", { shipping_address: "House 1", shipping_country_code: "BD", city: "c1", zone: "z1" });
    refused(() => db.exec("UPDATE orders SET zone = NULL WHERE id = 'o2'"));
  });

  it("needs a first line for every shipped order, and nothing for one that ships nothing", () => {
    // A raw row without a country is a Bangladesh address, as before 0113.
    insertOrder(db, "o1", { shipping_address: "House 1", city: "c1", zone: "z1" });
    refused(() => insertOrder(db, "o1b", { shipping_address: "House 1", city: "c1" }));
    refused(() => insertOrder(db, "o2", { shipping_address: "  ", shipping_country_code: "US", shipping_locality: "Cupertino", shipping_admin_area: "CA", shipping_postal_code: "95014" }));
    insertOrder(db, "o3", { requires_shipping: 0 });
  });

  it("needs what another country's rules require, unless staff skipped validation", () => {
    const us = { shipping_address: "1 Infinite Loop", shipping_country_code: "US", shipping_locality: "Cupertino", shipping_admin_area: "CA", shipping_postal_code: "95014" };
    insertOrder(db, "us_ok", us);
    refused(() => insertOrder(db, "us_no_zip", { ...us, shipping_postal_code: null }));
    refused(() => insertOrder(db, "us_no_state", { ...us, shipping_admin_area: "" }));
    insertOrder(db, "us_skipped", { ...us, shipping_postal_code: null, shipping_validation_skipped: 1 });
    // Singapore needs no city but a postal code; the UAE an emirate and no postal code.
    insertOrder(db, "sg", { shipping_address: "1 Raffles Pl", shipping_country_code: "SG", shipping_postal_code: "048616" });
    refused(() => insertOrder(db, "sg_no_zip", { shipping_address: "1 Raffles Pl", shipping_country_code: "SG" }));
    insertOrder(db, "ae", { shipping_address: "Villa 1", shipping_country_code: "AE", shipping_admin_area: "Dubai" });
    refused(() => insertOrder(db, "ae_no_emirate", { shipping_address: "Villa 1", shipping_country_code: "AE" }));
    refused(() => db.exec("UPDATE orders SET shipping_postal_code = NULL WHERE id = 'us_ok'"));
    expect(() => insertOrder(db, "bad_code", { ...us, shipping_country_code: "us" })).toThrow(/CHECK constraint failed/);
  });

  it("keeps one default address per customer and the delivery adapter in Bangladesh", () => {
    db.exec("INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111112')");
    db.exec("INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1) VALUES ('a1', 'cust_1', 1, 'BD', 'House 1')");
    db.exec("INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1) VALUES ('a2', 'cust_1', 0, 'IN', '12 MG Road')");
    expect(() => db.exec("INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1) VALUES ('a3', 'cust_1', 1, 'US', 'x')"))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => db.exec("UPDATE customer_addresses SET is_default = 1 WHERE id = 'a2'")).toThrow(/UNIQUE constraint failed/);
    expect(() => db.exec("INSERT INTO customer_addresses (id, customer_id, country_code, city, zone) VALUES ('a4', 'cust_1', 'IN', 'c1', 'z1')"))
      .toThrow(/CHECK constraint failed/);
    // Deleting the customer deletes the book, without a customer.updated for the gone customer.
    db.exec("DELETE FROM event_outbox");
    db.exec("DELETE FROM customers WHERE id = 'cust_1'");
    expect(db.prepare("SELECT count(*) AS n FROM customer_addresses").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT topic FROM event_outbox WHERE topic = 'customer.updated'").all()).toEqual([]);
  });

  it("seeds a guest record's default address from its first shipping order, never an account's", () => {
    db.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('guest', 'Karim', '+8801711111112');
      INSERT INTO customers (id, name, phone, account_claimed_at, phone_verified_at) VALUES ('account', 'Sumi', '+8801711111113', 1, 1);
    `);
    insertOrder(db, "pickup", { customer_id: "guest", requires_shipping: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM customer_addresses").get()).toEqual({ n: 0 });
    db.exec("DELETE FROM event_outbox");
    insertOrder(db, "first", {
      customer_id: "guest", shipping_address: "House 1", shipping_country_code: "BD", city: "c1", zone: "z1",
      city_name: "Dhaka", zone_name: "Dhanmondi", shipping_locality: "Dhaka", shipping_dependent_locality: "Dhanmondi",
    });
    insertOrder(db, "second", { customer_id: "guest", shipping_address: "Elsewhere 2", shipping_country_code: "BD", city: "c2", zone: "z2" });
    insertOrder(db, "account_order", { customer_id: "account", shipping_address: "House 5", shipping_country_code: "BD", city: "c1", zone: "z1" });
    expect(db.prepare("SELECT id, customer_id, is_default, country_code, line1, locality, dependent_locality, city, zone, city_name FROM customer_addresses").all()).toEqual([
      { id: "caddr_guest", customer_id: "guest", is_default: 1, country_code: "BD", line1: "House 1", locality: "Dhaka", dependent_locality: "Dhanmondi", city: "c1", zone: "z1", city_name: "Dhaka" },
    ]);
    // The record's first address is part of the record, as when it was a customer column: no customer.updated.
    expect(db.prepare("SELECT topic FROM event_outbox WHERE topic = 'customer.updated'").all()).toEqual([]);
  });

  it("makes every address-book write its customer's update", () => {
    db.exec("INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111112')");
    db.exec("DELETE FROM event_outbox");
    db.exec("INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1) VALUES ('a1', 'cust_1', 1, 'BD', 'House 1')");
    db.exec("UPDATE customer_addresses SET updated_at = updated_at + 1 WHERE id = 'a1'");
    db.exec("UPDATE customer_addresses SET line1 = 'House 2' WHERE id = 'a1'");
    db.exec("DELETE FROM customer_addresses WHERE id = 'a1'");
    expect(db.prepare("SELECT topic, resource_id, data FROM event_outbox ORDER BY rowid").all()).toEqual(
      Array.from({ length: 3 }, () => ({ topic: "customer.updated", resource_id: "cust_1", data: JSON.stringify({ customerId: "cust_1" }) })),
    );
    // A first address written with its record (`caddr_<customer id>`) is part of customer.created; changing it later is an update.
    db.exec("DELETE FROM event_outbox");
    db.exec("INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1) VALUES ('caddr_cust_1', 'cust_1', 1, 'BD', 'House 1')");
    expect(db.prepare("SELECT count(*) AS n FROM event_outbox").get()).toEqual({ n: 0 });
    db.exec("UPDATE customer_addresses SET line1 = 'House 3' WHERE id = 'caddr_cust_1'");
    expect(db.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic = 'customer.updated'").get()).toEqual({ n: 1 });
  });
});
