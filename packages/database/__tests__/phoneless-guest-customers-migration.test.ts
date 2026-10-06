// Migration 0117 (phone optional for digital and service orders): a contact
// without a phone is stored as '' (NO_PHONE). The one-guest-record-per-phone
// rule skips those records, and a phoneless guest record is keyed by its
// email instead. Indexes only; no table is rebuilt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0117_phoneless_guest_customers";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("only rebuilds indexes, on both providers", () => {
    for (const sql of [migration(), migration("postgres/")]) {
      const statements = sql.split(BREAKPOINT).map((statement) =>
        statement.replace(/^\s*(?:--[^\n]*\n)*/g, "").trim()).filter(Boolean);
      expect(statements).toHaveLength(4);
      expect(statements[0]).toMatch(/^DROP INDEX [`"]customers_guest_phone_unique[`"];$/);
      expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX [`"]customers_guest_phone_unique[`"]/);
      expect(statements[2]).toMatch(/^CREATE UNIQUE INDEX [`"]customers_guest_email_unique[`"]/);
      expect(statements[3]).toMatch(/^INSERT INTO [`"]scalius_schema_migrations[`"]/);
      expect(sql).not.toMatch(/ALTER TABLE|CREATE TABLE|PRAGMA/i);
    }
  });
});

describe("phoneless guest records", () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  const insert = (id: string, phone: string, email: string | null, extra = "") =>
    db!.exec(`INSERT INTO customers (id, name, phone, email${extra ? ", account_claimed_at" : ""})
      VALUES ('${id}', 'Buyer', '${phone}', ${email === null ? "NULL" : `'${email}'`}${extra ? `, ${extra}` : ""})`);

  it("keeps one guest record per phone and one phoneless guest record per email", () => {
    db = createMigratedSqlite();
    insert("cust_a", "+8801712000001", "a@example.test");
    expect(() => insert("cust_a2", "+8801712000001", "other@example.test")).toThrow(/UNIQUE/);

    // Many phoneless guests, one per email (any case).
    insert("cust_p1", "", "one@example.test");
    insert("cust_p2", "", "two@example.test");
    expect(() => insert("cust_p3", "", "ONE@example.test")).toThrow(/customers_guest_email_unique|UNIQUE/);

    // A guest with a phone may share an email with a phoneless guest.
    insert("cust_b", "+14155550100", "one@example.test");
    // Accounts without a phone are never guest records.
    insert("cust_acc1", "", "one@example.test", "unixepoch()");
    insert("cust_acc2", "", "one@example.test", "unixepoch()");
    // A retired phoneless guest frees its email.
    db.exec("UPDATE customers SET deleted_at = unixepoch() WHERE id = 'cust_p2'");
    insert("cust_p4", "", "two@example.test");

    const phoneless = db.prepare("SELECT count(*) AS n FROM customers WHERE phone = ''").get() as { n: number };
    expect(phoneless.n).toBe(5);
  });
});
