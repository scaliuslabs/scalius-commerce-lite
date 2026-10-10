// Migration 0127 (dashboard list indexes): index-only, safe to replay, and
// each replaced updated-at list index is dropped only after its successor
// exists. The plans the lists rely on are proved in packages/core
// (orders/admin/list-scale.d1.test.ts and the customer and product tests).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0127_list_indexes";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");
const statements = (sql: string) => sql.split(BREAKPOINT).map((statement) => statement.trim()).filter(Boolean);

const CREATED = [
  "orders_list_updated_idx", "orders_list_created_idx", "orders_list_total_idx", "orders_list_customer_name_idx",
  "orders_list_status_idx", "orders_list_payment_status_idx", "orders_list_payment_method_idx",
  "orders_list_fulfillment_idx", "orders_list_channel_idx", "orders_list_archived_idx", "orders_list_pickup_idx",
  "products_list_updated_idx", "products_list_created_idx", "products_list_name_idx", "products_list_price_idx", "products_list_trash_idx",
  "customers_list_updated_idx", "customers_list_created_idx", "customers_list_name_idx", "customers_list_trash_idx", "product_reviews_status_list_idx", "product_reviews_created_idx",
  "cod_tracking_status_idx", "delivery_shipments_tracking_lookup_idx", "delivery_shipments_external_lookup_idx",
];
const DROPPED = [
  "orders_archive_list_idx", "orders_payment_status_list_idx", "orders_payment_method_list_idx",
  "orders_fulfillment_list_idx", "orders_channel_list_idx", "product_reviews_status_created_idx",
];

describe(`${NAME} files`, () => {
  it("only creates and drops indexes, idempotently, creating every index before it drops one", () => {
    for (const sql of [migration(), migration("postgres/")]) {
      const body = statements(sql).slice(0, -1).map((statement) => statement.replace(/^(?:--[^\n]*\n)*/, ""));
      expect(body.every((statement) => /^(CREATE INDEX IF NOT EXISTS|DROP INDEX IF EXISTS) /.test(statement))).toBe(true);
      const firstDrop = body.findIndex((statement) => statement.startsWith("DROP"));
      expect(body.slice(firstDrop).every((statement) => statement.startsWith("DROP"))).toBe(true);
      expect(body.slice(0, firstDrop)).toHaveLength(CREATED.length);
      expect(body.slice(firstDrop)).toHaveLength(DROPPED.length);
      expect(sql).not.toMatch(/CONCURRENTLY|PRAGMA|__new_/);
    }
  });
});

describe(`${NAME} over a populated 0126 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  const indexNames = () => new Set((db!.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
    .map((row) => row.name));

  it("adds the list indexes, drops the replaced ones, keeps the rows and replays harmlessly", () => {
    db = createMigratedSqlite({ beforeMigration: "0127_" });
    db.exec("INSERT INTO customers (id, name, phone) VALUES ('cus_1', 'Rahim', '+8801711000001')");
    const before = indexNames();
    for (const name of DROPPED) expect(before.has(name), name).toBe(true);

    const sql = compiledMigrationSql("d1", undefined, "0127_");
    db.exec(sql);
    const after = indexNames();
    for (const name of CREATED) expect(after.has(name), name).toBe(true);
    for (const name of DROPPED) expect(after.has(name), name).toBe(false);
    expect((db.prepare("SELECT count(*) AS n FROM customers").get() as { n: number }).n).toBe(1);

    // A replay (a lost response) changes nothing but the ledger row it repeats.
    const body = statements(migration()).slice(0, -1).join(";\n");
    db.exec(body);
    expect(indexNames()).toEqual(after);
  });
});
