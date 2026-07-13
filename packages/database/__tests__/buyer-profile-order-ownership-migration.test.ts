import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0025_customer_order_ownership.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const legacySchema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE customers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT NOT NULL UNIQUE,
    address TEXT,
    city TEXT,
    zone TEXT,
    area TEXT,
    city_name TEXT,
    zone_name TEXT,
    area_name TEXT,
    account_claimed_at INTEGER,
    phone_verified_at INTEGER,
    email_verified_at INTEGER,
    last_authenticated_at INTEGER,
    profile_completion_required_at INTEGER,
    profile_completed_at INTEGER,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_spent REAL NOT NULL DEFAULT 0,
    last_order_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_email TEXT,
    shipping_address TEXT NOT NULL,
    city TEXT NOT NULL,
    zone TEXT NOT NULL,
    area TEXT,
    city_name TEXT,
    zone_name TEXT,
    area_name TEXT,
    status TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    paid_amount REAL NOT NULL DEFAULT 0,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE customer_history (
    id TEXT PRIMARY KEY NOT NULL,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT NOT NULL,
    address TEXT,
    city TEXT,
    zone TEXT,
    area TEXT,
    city_name TEXT,
    zone_name TEXT,
    area_name TEXT,
    change_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

describe("buyer profile and order ownership migration", () => {
  it("preserves existing ownership while linking guest orders only to CRM profiles", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        INSERT INTO customers (
          id, name, phone, account_claimed_at, total_orders, total_spent, created_at, updated_at
        ) VALUES
          ('cust_account', 'Account buyer', '+8801711111111', 50, 99, 9999, 10, 10),
          ('cust_existing_guest', 'Existing guest', '+8801722222222', NULL, 0, 0, 15, 15);
        INSERT INTO orders VALUES
          ('account_order', 'Account buyer', '+8801711111111', NULL, 'Old address', 'dhaka', 'zone', NULL, 'Dhaka', 'Zone', NULL, 'completed', 'paid', 500, 'cust_account', 100, 100, NULL),
          ('existing_guest_order', 'New guest snapshot', '+8801722222222', NULL, 'Guest address', 'dhaka', 'zone', NULL, 'Dhaka', 'Zone', NULL, 'pending', 'unpaid', 0, NULL, 200, 200, NULL),
          ('guest_old', 'Guest old', '+8801733333333', 'old@example.com', 'Old guest address', 'dhaka', 'zone', NULL, 'Dhaka', 'Zone', NULL, 'pending', 'unpaid', 0, NULL, 300, 300, NULL),
          ('guest_new', 'Guest latest', '+8801733333333', 'latest@example.com', 'Latest guest address', 'dhaka', 'zone', NULL, 'Dhaka', 'Zone', NULL, 'completed', 'paid', 700, NULL, 400, 400, NULL);
        ${migration}
        SELECT id || ':' || customer_id || ':' || COALESCE(account_owner_customer_id, '-')
        FROM orders ORDER BY id;
        SELECT phone || ':' || name || ':' || total_orders || ':' || total_spent || ':' || last_order_at
        FROM customers ORDER BY phone;
        SELECT customer_id || ':' || change_type FROM customer_history ORDER BY customer_id;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "account_order:cust_account:cust_account",
      "existing_guest_order:cust_existing_guest:-",
      "guest_new:cust_guest_guest_new:-",
      "guest_old:cust_guest_guest_new:-",
      "+8801711111111:Account buyer:1:500.0:100",
      "+8801722222222:Existing guest:1:0.0:200",
      "+8801733333333:Guest latest:2:700.0:400",
      "cust_guest_guest_new:created",
    ]);
  });
});
