import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { generateRecommendationOrderProductsTriggers, RECOMMENDATION_ORDER_PRODUCTS_MIGRATION, renderRecommendationOrderProductsMigration } from "../scripts/recommendation-order-products";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { recommendationProjectionActual, recommendationProjectionMutations, recommendationProjectionOracle, recommendationProjectionSeed } from "./recommendation-order-products-fixture";

const read = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${RECOMMENDATION_ORDER_PRODUCTS_MIGRATION}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

describe("recommendation order/product projection", () => {
  it("reproduces portable artifacts and installs additive source dependency repairs", () => {
    const generated = renderRecommendationOrderProductsMigration(statements(read()).filter((s) => /^CREATE (?:TABLE|INDEX) /i.test(s)));
    expect(generated.sqlite).toBe(read());
    expect(generated.postgres).toBe(read("postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((m) => m.version === 139)?.sourceSha256).toBe(generated.digest);
    expect(cacheDepTriggersForMigration(RECOMMENDATION_ORDER_PRODUCTS_MIGRATION).map((t) => t.name))
      .toEqual(["cdep_orders_upd", "cdep_orders_upd_old", "cdep_order_items_upd"]);
    for (const trigger of generateRecommendationOrderProductsTriggers()) {
      expect(trigger.sqlite.slice(trigger.sqlite.indexOf("BEGIN\n")).match(/;/g)).toHaveLength(1);
      expect(trigger.sqlite).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
    }
  });

  it("backfills exact distinct pairs without touching source rows or existing dependency clocks", () => {
    const db = createMigratedSqlite({ beforeMigration: "0139_" });
    try {
      db.exec(recommendationProjectionSeed);
      const preserve = () => ["orders", "order_items", "cache_dep", "cache_clock", "event_outbox"]
        .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = preserve();
      db.exec(read());
      expect(preserve()).toEqual(before);
      expect(db.prepare(recommendationProjectionActual).all()).toEqual(db.prepare(recommendationProjectionOracle).all());
      expect(db.prepare("SELECT buyer FROM recommendation_order_products WHERE order_id='b'").get()).toEqual({ buyer: "buyer@example.com" });
      expect(db.prepare("SELECT buyer FROM recommendation_order_products WHERE order_id='c'").get()).toEqual({ buyer: null });
      expect(db.prepare("SELECT buyer FROM recommendation_order_products WHERE order_id='d'").get()).toEqual({ buyer: "" });
      for (const mutation of recommendationProjectionMutations) {
        db.exec(mutation);
        expect(db.prepare(recommendationProjectionActual).all(), mutation).toEqual(db.prepare(recommendationProjectionOracle).all());
      }
      const rows = db.prepare(recommendationProjectionActual).all();
      db.exec("BEGIN; DELETE FROM orders; ROLLBACK");
      expect(db.prepare(recommendationProjectionActual).all()).toEqual(rows);
      db.exec("BEGIN; UPDATE orders SET status='cancelled'; ROLLBACK");
      expect(db.prepare(recommendationProjectionActual).all()).toEqual(rows);
    } finally { db.close(); }
  });

  it("writes once for duplicate lines, never for money-only changes, and invalidates email/line-time changes", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(recommendationProjectionSeed);
      let writes = 0;
      db.function("projection_write", () => { writes += 1; return 0; });
      for (const event of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER count_projection_${event} AFTER ${event} ON recommendation_order_products BEGIN SELECT projection_write(); END`);
      for (let index = 0; index < 99; index += 1) db.exec(`INSERT INTO order_items(id,order_id,product_id,quantity) VALUES ('many_${index}','a','p3',1)`);
      expect(writes).toBe(1);
      db.exec("UPDATE order_items SET unit_price_minor=10,quantity=2 WHERE order_id='a'; UPDATE orders SET shipping_amount_minor=10 WHERE id='a'");
      expect(writes).toBe(1);
      const sequence = () => Number(db.prepare("SELECT seq FROM cache_dep WHERE dep='recommendation-signals'").get()!.seq);
      const beforeEmail = sequence();
      db.exec("UPDATE orders SET customer_email='Next@Example.COM' WHERE id='b'");
      expect(sequence()).toBeGreaterThan(beforeEmail);
      expect(writes).toBe(2);
      expect(db.prepare("SELECT buyer FROM recommendation_order_products WHERE order_id='b'").get()).toEqual({ buyer: "next@example.com" });
      const beforeLineTime = sequence();
      db.exec("UPDATE order_items SET created_at=created_at+1 WHERE id='b1'");
      expect(sequence()).toBeGreaterThan(beforeLineTime);
      expect(writes).toBe(2);
      db.exec("DELETE FROM order_items WHERE product_id='p3'");
      expect(writes).toBe(3);
      expect(db.prepare(recommendationProjectionActual).all()).toEqual(db.prepare(recommendationProjectionOracle).all());
      expect(db.prepare("EXPLAIN QUERY PLAN SELECT product_id,from_minor,to_minor FROM product_buyer_state WHERE is_public=1").all()
        .map((row) => row.detail).join("\n")).toContain("COVERING INDEX product_buyer_state_scope_idx");
    } finally { db.close(); }
  });

  it("maintains the same pair semantics on the actual Turso engine", async () => {
    const db = await connect(":memory:");
    try {
      await db.exec("PRAGMA foreign_keys=ON");
      await db.exec(`CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT,slug TEXT);
        CREATE TABLE orders(id TEXT PRIMARY KEY,customer_name TEXT,customer_phone TEXT,customer_email TEXT,
          shipping_address TEXT,city TEXT,zone TEXT,status TEXT,created_at INTEGER,deleted_at INTEGER);
        CREATE TABLE order_items(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
          product_id TEXT REFERENCES products(id),quantity INTEGER,created_at INTEGER);
        CREATE INDEX order_items_order_product_idx ON order_items(order_id,product_id);
        CREATE TABLE cache_clock(id INTEGER PRIMARY KEY,seq INTEGER,floor INTEGER,coarse INTEGER);
        INSERT INTO cache_clock VALUES(1,0,0,0);
        CREATE TABLE cache_dep(dep TEXT PRIMARY KEY,seq INTEGER);
        CREATE TABLE scalius_schema_migrations(version INTEGER PRIMARY KEY,name TEXT,source_sha256 TEXT);
        CREATE TABLE product_buyer_state(is_public INTEGER,product_id TEXT,from_minor INTEGER,to_minor INTEGER)`);
      for (const statement of recommendationProjectionSeed.split(";").filter((s) => s.trim())) await db.exec(statement);
      for (const statement of statements(read())) await db.exec(statement);
      const assertProjection = async () => expect(await db.prepare(recommendationProjectionActual).all()).toEqual(await db.prepare(recommendationProjectionOracle).all());
      await assertProjection();
      for (const mutation of recommendationProjectionMutations) { await db.exec(mutation); await assertProjection(); }
      const before = await db.prepare(recommendationProjectionActual).all();
      await db.exec("BEGIN; DELETE FROM orders; ROLLBACK");
      expect(await db.prepare(recommendationProjectionActual).all()).toEqual(before);
    } finally { await db.close(); }
  });
});
