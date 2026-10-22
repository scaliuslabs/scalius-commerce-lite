import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedSqlite, createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { customerAddresses, customers } from "@scalius/database/schema";
import { getTableColumns, getTableName } from "drizzle-orm";
import { buildCustomerAuthOtpStorageKey, persistCustomerAuthOtpChallenge } from "./customer-auth-otp-challenges";
import { deriveCustomerAuthOtpDeliveryCode, verifyOtp } from "./customer-auth.service";

const KEY = btoa("0123456789abcdef0123456789abcdef");
const PHONE = "+8801712345678";
const EMAIL = "buyer@example.test";
const migration = readFileSync(new URL("../../../../database/migrations/0144_customer_contact_lookup.sql", import.meta.url), "utf8");
type ExecutedQuery = { sql: string; params: readonly SQLInputValue[] };
let sqlite: DatabaseSync;
let db: Database;
let queries: ExecutedQuery[];

beforeEach(() => {
  sqlite = createMigratedSqlite({ beforeMigration: "0144_" });
  // Today's code reads today's customer columns; a later migration's columns are
  // added bare so this file isolates 0144's query plan, not the schema since.
  for (const table of [customers, customerAddresses]) {
    const name = getTableName(table);
    const present = new Set((sqlite.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((column) => column.name));
    for (const column of Object.values(getTableColumns(table))) {
      if (!present.has(column.name)) sqlite.exec(`ALTER TABLE "${name}" ADD COLUMN "${column.name}"`);
    }
  }
  queries = [];
  db = createSqliteD1Database({ sqlite, onQuery: (sql, params) => queries.push({ sql, params }) }).db;
  sqlite.exec(`INSERT INTO settings (id, key, value, type, category)
    VALUES ('auth', 'document', '{"email":"optional","whatsapp":"off","channels":["email","sms"]}', 'json', 'customer_auth')`);
  const insert = sqlite.prepare(`INSERT INTO orders
    (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, total_amount_minor, created_at, deleted_at)
    VALUES (?, ?, ?, ?, 'House 1', 'city', 'zone', 100, ?, ?)`);
  insert.run("ord_older", "Older", PHONE, EMAIL, 100, null);
  insert.run("ord_a", "Tie loser", PHONE, " Buyer@Example.Test ", 200, null);
  insert.run("ord_z", "Latest live buyer", PHONE, " BUYER@EXAMPLE.TEST ", 200, null);
  insert.run("ord_deleted", "Newer deleted", PHONE, EMAIL, 300, 300);
  insert.run("ord_other", "Other contact", "+8801799999999", "other@example.test", 400, null);
});
afterEach(() => sqlite.close());

async function proveContact(method: "email" | "phone", enteredIdentifier: string) {
  const identifier = method === "email" ? enteredIdentifier.trim().toLowerCase() : enteredIdentifier;
  const channel = method === "email" ? "email" : "sms";
  const otpKey = await buildCustomerAuthOtpStorageKey(channel, identifier, KEY);
  const deliveryKey = "contact-lookup-test";
  const code = await deriveCustomerAuthOtpDeliveryCode({ otpKey, deliveryKey, encryptionKey: KEY });
  await persistCustomerAuthOtpChallenge(db, {
    otpKey, deliveryKey, method, channel, identifier, deliveryTarget: identifier, code,
    encryptionKey: KEY, contactEncryptionKey: KEY, ttlSeconds: 300, resendCooldownSeconds: 60, maxAttempts: 5,
  });
  return verifyOtp(db, { method, identifier: enteredIdentifier, code, encryptionKey: KEY, sessionHashKey: KEY });
}

function contactQuery(): ExecutedQuery {
  // Capture the actual service's Drizzle-emitted SQL and bindings, not a test reconstruction.
  const query = queries.find((entry) => entry.sql.includes('from "orders"')
    && entry.sql.includes('order by "orders"."created_at" desc, "orders"."id" desc'));
  expect(query).toBeDefined();
  return query!;
}
function plan(query: ExecutedQuery) {
  expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_stat1'").get()).toBeUndefined();
  return sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params).map((row) => row.detail).join("\n");
}

describe("latest order for a proven contact", () => {
  it.each([
    ["email", EMAIL],
    ["email", "  BUYER@Example.Test  "],
    ["phone", PHONE],
  ] as const)("seeks the newest live %s match without statistics (%s)", async (method, identifier) => {
    sqlite.exec(migration);
    await expect(proveContact(method, identifier)).resolves.toMatchObject({
      status: "needs_account_details",
      suggestion: { name: "Latest live buyer", phone: PHONE, address: { text: "House 1" } },
    });
    const query = contactQuery();
    const detail = plan(query);
    expect(detail).toContain(`SEARCH orders USING INDEX orders_customer_${method}_lookup_idx`);
    expect(detail).not.toMatch(/SCAN orders|USE TEMP B-TREE|orders_sales_rollup_idx/);
    expect(query.params).toEqual([method === "email" ? EMAIL : PHONE, 1]);
  });

  it("replaces the old no-statistics rollup scan plan with a contact seek on upgrade", async () => {
    await proveContact("email", EMAIL);
    const emitted = contactQuery();
    // The old service sorted only by created_at. EXPLAIN it against five fixture rows.
    const old = { ...emitted, sql: emitted.sql.replace(', "orders"."id" desc', "") };
    expect(plan(old)).toContain("orders_sales_rollup_idx");
    sqlite.exec(migration);
    expect(plan(emitted)).toContain("SEARCH orders USING INDEX orders_customer_email_lookup_idx");
    expect(plan(emitted)).not.toMatch(/SCAN orders|USE TEMP B-TREE|orders_sales_rollup_idx/);
  });
});
