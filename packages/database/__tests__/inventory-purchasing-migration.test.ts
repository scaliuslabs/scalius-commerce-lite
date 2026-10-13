// Migration 0109 (inventory operations): SKU unit cost and the order-line
// cost snapshot, suppliers, purchase orders, transfers, the multi-SKU command
// ledger, the new ledger-v2 movement types and their immutability guards. It
// applies over a populated 0108 store: legacy (v1 and pre-0065 v2) movements,
// levels, orders and their lines keep every row and value, and the old rows
// still take the edits the earlier rules allowed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "@tursodatabase/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseEventFacts, type EventTopic } from "../../shared/src/events";
import { compiledMigrationSql, createMigratedSqlite, execOnTursoEngine } from "../src/testing/sqlite-d1";

const NAME = "0109_inventory_purchasing";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

const MOVEMENT_COLUMNS = `id, variant_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
  stock_version_before, stock_version_after, stock_delta,
  previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
  previous_preorder_stock, new_preorder_stock, preorder_stock_delta, location_id`;

/** A v2 physical movement of `delta` units at `location` from the SKU's current counters. */
function movement(db: DatabaseSync, id: string, type: string, quantity: number, delta: number, location: string | null) {
  const sku = db.prepare("SELECT stock, stock_version FROM product_variants WHERE id = 'var_a'").get() as { stock: number; stock_version: number };
  db.prepare(`INSERT INTO inventory_movements (${MOVEMENT_COLUMNS})
    VALUES (?, 'var_a', ?, ?, ?, ?, 2, 'regular', ?, ?, ?, 0, 0, 0, 0, 0, 0, ?)`)
    .run(id, type, quantity, sku.stock, sku.stock + delta, sku.stock_version, sku.stock_version + 1, delta, location);
  db.prepare("UPDATE product_variants SET stock = stock + ?, stock_version = stock_version + 1 WHERE id = 'var_a'").run(delta);
}

const level = (db: DatabaseSync, location: string) =>
  (db.prepare("SELECT on_hand FROM inventory_levels WHERE variant_id = 'var_a' AND location_id = ?").get(location) as { on_hand: number } | undefined)?.on_hand ?? 0;

describe(`${NAME} files`, () => {
  it("keeps trigger bodies remote-D1 safe and the PostgreSQL sidecar transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob|DROP TRIGGER/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*(?:--[^\n]*\s*)*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/\bCASE\b/i);
    }
  });
});

describe(`${NAME} over a populated 0108 store`, () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createMigratedSqlite({ beforeMigration: "0109_", foreignKeys: false });
    db.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_a', 'Kurta', 'kurta', 80000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
        VALUES ('var_a', 'prod_a', 'KURTA', 80000, 5, 0, 1, 1, 1);
      INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position)
        VALUES ('loc_b', 'Branch', 'BR', 'store', 0, 'active', 1);
    `);
    // A legacy v1 row and a v2 row written before the 0065 rules (an
    // operation type those rules retired): history the migration must keep.
    db.exec("DROP TRIGGER `inventory_movements_ledger_v2_insert_semantics`");
    db.exec(`INSERT INTO inventory_movements (id, variant_id, type, quantity, previous_stock, new_stock, ledger_version)
      VALUES ('legacy_v1', 'var_a', 'adjusted', 2, 3, 5, 1)`);
    db.exec(`INSERT INTO inventory_movements (${MOVEMENT_COLUMNS})
      VALUES ('legacy_v2', 'var_a', 'stocktake', 0, 5, 5, 2, 'regular', 0, 1, 0, 0, 0, 0, 0, 0, 0, NULL)`);
    db.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_old', 'Rahim', '+8801711111111', 'House 1', 'city', 'zone', 'confirmed')`);
    db.exec(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor)
      VALUES ('item_old', 'ord_old', 'prod_a', 'var_a', 1, 'Kurta', 80000)`);
    db.exec(compiledMigrationSql("d1", "0110_", "0109_"));
    db.exec("PRAGMA foreign_keys = ON");
  });
  afterEach(() => db.close());

  it("keeps every existing row, level and value, and adds no costs", () => {
    expect(db.prepare("SELECT id, type, ledger_version FROM inventory_movements ORDER BY id").all()).toEqual([
      { id: "legacy_v1", type: "adjusted", ledger_version: 1 },
      { id: "legacy_v2", type: "stocktake", ledger_version: 2 },
    ]);
    expect(db.prepare("SELECT stock, stock_version, cost_minor FROM product_variants WHERE id = 'var_a'").get())
      .toEqual({ stock: 5, stock_version: 1, cost_minor: null });
    expect(level(db, "loc_default")).toBe(5);
    expect(db.prepare("SELECT unit_price_minor, unit_cost_minor FROM order_items WHERE id = 'item_old'").get())
      .toEqual({ unit_price_minor: 80000, unit_cost_minor: null });
    // The 0102 rule stands: a legacy row takes a note; its operation stays put.
    expect(() => db.exec("UPDATE inventory_movements SET notes = 'counted twice' WHERE id = 'legacy_v2'")).not.toThrow();
    expect(() => db.exec("UPDATE inventory_movements SET type = 'received' WHERE id = 'legacy_v2'"))
      .toThrow(/invalid inventory ledger v2 operation semantics/);
    // An unrelated order line edit (amendments update lines in place) still works.
    expect(() => db.exec("UPDATE order_items SET quantity = 2 WHERE id = 'item_old'")).not.toThrow();
  });

  it("accepts received and transfer movements with their exact semantics and keeps sum(levels) = stock", () => {
    movement(db, "mv_received", "received", 4, 4, "loc_b");
    movement(db, "mv_out", "transfer_out", -3, -3, "loc_default");
    expect(db.prepare("SELECT stock FROM product_variants WHERE id = 'var_a'").get()).toEqual({ stock: 6 });
    movement(db, "mv_in", "transfer_in", 3, 3, "loc_b");
    expect([level(db, "loc_default"), level(db, "loc_b")]).toEqual([2, 7]);
    const total = db.prepare("SELECT SUM(on_hand) AS total FROM inventory_levels WHERE variant_id = 'var_a'").get() as { total: number };
    expect(total.total).toBe(9);
    expect(db.prepare("SELECT stock FROM product_variants WHERE id = 'var_a'").get()).toEqual({ stock: 9 });

    // Wrong signs, pools or reservation effects are refused.
    const bad = (id: string, type: string, quantity: number, delta: number, pool = "regular", reserved = 0) => () => db.prepare(`
      INSERT INTO inventory_movements (${MOVEMENT_COLUMNS})
      VALUES (?, 'var_a', ?, ?, 9, ?, 2, ?, 9, 10, ?, 0, ?, ?, 0, 0, 0, 'loc_b')`)
      .run(id, type, quantity, 9 + delta, pool, delta, reserved, reserved);
    expect(bad("b1", "received", -2, -2)).toThrow(/semantics/);
    expect(bad("b2", "received", 2, 3)).toThrow(/semantics/);
    expect(bad("b3", "transfer_out", 2, -2)).toThrow(/semantics/);
    expect(bad("b4", "transfer_in", 2, 2, "preorder")).toThrow(/semantics/);
    expect(bad("b5", "transfer_in", 2, 2, "regular", 2)).toThrow(/semantics/);
    // A removal still needs the units at its location; a receipt needs an active one.
    expect(() => movement(db, "mv_short", "transfer_out", -5, -5, "loc_default")).toThrow(/INVENTORY_LEVEL_SHORTFALL/);
    expect(() => movement(db, "mv_nowhere", "received", 1, 1, null)).toThrow(/INVENTORY_LOCATION_REQUIRED/);
  });

  it("guards SKU costs and snapshots them on every new order line, immutably", () => {
    expect(() => db.exec("UPDATE product_variants SET cost_minor = -1 WHERE id = 'var_a'")).toThrow(/PRODUCT_VARIANT_COST_INVALID/);
    expect(() => db.exec("UPDATE product_variants SET cost_minor = 12.5 WHERE id = 'var_a'")).toThrow(/PRODUCT_VARIANT_COST_INVALID/);
    expect(() => db.exec("UPDATE product_variants SET cost_minor = 9007199254740992 WHERE id = 'var_a'")).toThrow(/PRODUCT_VARIANT_COST_INVALID/);
    expect(() => db.exec(`INSERT INTO product_variants (id, product_id, sku, is_default, cost_minor, option_combination_key)
      VALUES ('var_bad', 'prod_a', 'BAD', 0, -5, 'x')`)).toThrow(/PRODUCT_VARIANT_COST_INVALID/);
    db.exec("UPDATE product_variants SET cost_minor = 45000 WHERE id = 'var_a'");

    db.exec(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor)
      VALUES ('item_new', 'ord_old', 'prod_a', 'var_a', 1, 'Kurta', 80000)`);
    expect(db.prepare("SELECT unit_cost_minor FROM order_items WHERE id = 'item_new'").get()).toEqual({ unit_cost_minor: 45000 });
    // A later cost change never rewrites the line; nothing can rewrite it.
    db.exec("UPDATE product_variants SET cost_minor = 50000 WHERE id = 'var_a'");
    expect(db.prepare("SELECT unit_cost_minor FROM order_items WHERE id = 'item_new'").get()).toEqual({ unit_cost_minor: 45000 });
    expect(() => db.exec("UPDATE order_items SET unit_cost_minor = 1 WHERE id = 'item_new'")).toThrow(/frozen/);
    // A SKU without a cost leaves the line without one.
    db.exec("UPDATE product_variants SET cost_minor = NULL WHERE id = 'var_a'");
    db.exec(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor)
      VALUES ('item_free', 'ord_old', 'prod_a', 'var_a', 1, 'Kurta', 80000)`);
    expect(db.prepare("SELECT unit_cost_minor FROM order_items WHERE id = 'item_free'").get()).toEqual({ unit_cost_minor: null });
  });

  it("locks purchase order lines once ordered and keeps receipts and commands append-only", () => {
    db.exec(`
      INSERT INTO suppliers (id, name) VALUES ('sup_1', 'Dhaka Textiles');
      INSERT INTO purchase_orders (id, number, supplier_id, destination_location_id, currency_code) VALUES ('po_1', 1001, 'sup_1', 'loc_b', 'BDT');
      INSERT INTO purchase_order_lines (id, purchase_order_id, variant_id, quantity, unit_cost_minor) VALUES ('pol_1', 'po_1', 'var_a', 10, 40000);
    `);
    db.exec("UPDATE purchase_order_lines SET quantity = 12 WHERE id = 'pol_1'");
    db.exec("UPDATE purchase_orders SET status = 'ordered', revision = revision + 1 WHERE id = 'po_1'");
    expect(() => db.exec("UPDATE purchase_order_lines SET quantity = 20 WHERE id = 'pol_1'")).toThrow(/PURCHASE_ORDER_LINES_LOCKED/);
    expect(() => db.exec("UPDATE purchase_order_lines SET unit_cost_minor = 1 WHERE id = 'pol_1'")).toThrow(/PURCHASE_ORDER_LINES_LOCKED/);
    expect(() => db.exec(`INSERT INTO purchase_order_lines (id, purchase_order_id, variant_id, quantity, unit_cost_minor)
      VALUES ('pol_2', 'po_1', 'var_a', 1, 1)`)).toThrow(/PURCHASE_ORDER_LINES_LOCKED/);
    expect(() => db.exec("DELETE FROM purchase_order_lines WHERE id = 'pol_1'")).toThrow(/PURCHASE_ORDER_LINES_LOCKED/);
    db.exec("UPDATE purchase_order_lines SET received_quantity = 5 WHERE id = 'pol_1'");
    expect(() => db.exec("UPDATE purchase_order_lines SET received_quantity = 4 WHERE id = 'pol_1'")).toThrow(/never decrease/);
    expect(() => db.exec("UPDATE purchase_order_lines SET received_quantity = 13 WHERE id = 'pol_1'")).toThrow(/CHECK/);

    movement(db, "mv_po", "received", 5, 5, "loc_b");
    db.exec(`
      INSERT INTO inventory_commands (operation_key, request_hash, command_type, subject_id, subject_revision, result_payload)
        VALUES ('op_1', 'h', 'purchase_order_receive', 'po_1', 3, '{}');
      INSERT INTO purchase_order_receipt_lines (id, operation_key, purchase_order_id, purchase_order_line_id, variant_id, location_id, movement_id, quantity, unit_cost_minor)
        VALUES ('porl_1', 'op_1', 'po_1', 'pol_1', 'var_a', 'loc_b', 'mv_po', 5, 40000);
    `);
    for (const statement of [
      "UPDATE inventory_commands SET result_payload = '[]'",
      "DELETE FROM inventory_commands",
      "UPDATE purchase_order_receipt_lines SET quantity = 1",
      "DELETE FROM purchase_order_receipt_lines",
    ]) expect(() => db.exec(statement), statement).toThrow(/immutable/);
    // A PO with receipts keeps them; the SKU it bought cannot be hard-deleted.
    expect(() => db.exec("DELETE FROM purchase_orders WHERE id = 'po_1'")).toThrow(/FOREIGN KEY|LOCKED/);
    expect(() => db.exec("DELETE FROM product_variants WHERE id = 'var_a'")).toThrow(/FOREIGN KEY/);
  });

  it("enforces transfer line progress and refuses a transfer to its own origin", () => {
    expect(() => db.exec(`INSERT INTO inventory_transfers (id, number, origin_location_id, destination_location_id)
      VALUES ('trf_x', 1, 'loc_b', 'loc_b')`)).toThrow(/CHECK/);
    db.exec(`
      INSERT INTO inventory_transfers (id, number, origin_location_id, destination_location_id) VALUES ('trf_1', 1001, 'loc_default', 'loc_b');
      INSERT INTO inventory_transfer_lines (id, transfer_id, variant_id, quantity) VALUES ('trl_1', 'trf_1', 'var_a', 4);
    `);
    expect(() => db.exec("UPDATE inventory_transfer_lines SET shipped_quantity = 2 WHERE id = 'trl_1'")).toThrow(/CHECK/);
    db.exec("UPDATE inventory_transfers SET status = 'in_transit', revision = 2 WHERE id = 'trf_1'");
    db.exec("UPDATE inventory_transfer_lines SET shipped_quantity = 4 WHERE id = 'trl_1'");
    expect(() => db.exec("UPDATE inventory_transfer_lines SET quantity = 5 WHERE id = 'trl_1'")).toThrow(/INVENTORY_TRANSFER_LINES_LOCKED/);
    db.exec("UPDATE inventory_transfer_lines SET received_quantity = 3 WHERE id = 'trl_1'");
    expect(() => db.exec("UPDATE inventory_transfer_lines SET returned_quantity = 2 WHERE id = 'trl_1'")).toThrow(/CHECK/);
    db.exec("UPDATE inventory_transfer_lines SET returned_quantity = 1 WHERE id = 'trl_1'");
    expect(() => db.exec("UPDATE inventory_transfer_lines SET received_quantity = 2 WHERE id = 'trl_1'")).toThrow(/never decreases/);
  });

  it("emits one readable event per purchase order and transfer write", () => {
    db.exec("DELETE FROM event_outbox");
    db.exec(`
      INSERT INTO purchase_orders (id, number, destination_location_id, currency_code) VALUES ('po_e', 1002, 'loc_default', 'BDT');
      UPDATE purchase_orders SET notes = 'no revision change' WHERE id = 'po_e';
      UPDATE purchase_orders SET status = 'ordered', revision = 2 WHERE id = 'po_e';
      INSERT INTO purchase_orders (id, number, destination_location_id, currency_code) VALUES ('po_d', 1003, 'loc_default', 'BDT');
      DELETE FROM purchase_orders WHERE id = 'po_d';
      INSERT INTO inventory_transfers (id, number, origin_location_id, destination_location_id) VALUES ('trf_e', 1002, 'loc_default', 'loc_b');
      UPDATE inventory_transfers SET status = 'in_transit', revision = 2 WHERE id = 'trf_e';
    `);
    const rows = db.prepare("SELECT topic, resource_type, resource_id, data FROM event_outbox ORDER BY rowid").all() as Array<{ topic: EventTopic; resource_type: string; resource_id: string; data: string }>;
    expect(rows.map((row) => [row.topic, row.resource_type, row.resource_id])).toEqual([
      ["inventory.purchase_order_updated", "purchase_order", "po_e"],
      ["inventory.purchase_order_updated", "purchase_order", "po_e"],
      ["inventory.purchase_order_updated", "purchase_order", "po_d"],
      ["inventory.purchase_order_updated", "purchase_order", "po_d"],
      ["inventory.transfer_updated", "inventory_transfer", "trf_e"],
      ["inventory.transfer_updated", "inventory_transfer", "trf_e"],
    ]);
    expect(rows.map((row) => parseEventFacts(row.topic, row.data))).toEqual([
      { purchaseOrderId: "po_e", previousStatus: null, status: "draft", revision: 1 },
      { purchaseOrderId: "po_e", previousStatus: "draft", status: "ordered", revision: 2 },
      { purchaseOrderId: "po_d", previousStatus: null, status: "draft", revision: 1 },
      { purchaseOrderId: "po_d", previousStatus: "draft", status: "deleted", revision: 1 },
      { transferId: "trf_e", previousStatus: null, status: "draft", revision: 1 },
      { transferId: "trf_e", previousStatus: "draft", status: "in_transit", revision: 2 },
    ]);
  });
});

describe(`${NAME} on the Turso engine`, () => {
  it("applies every 0109 statement and enforces its movement, cost and line rules", async () => {
    const database = await connect(":memory:");
    const own = new Set(compiledMigrationSql("turso", undefined, `${NAME}.sql`).split(BREAKPOINT).map((statement) => statement.trim()));
    for (const statement of compiledMigrationSql("turso").split(BREAKPOINT)) {
      if (!statement.trim()) continue;
      try {
        await execOnTursoEngine(database, statement);
      } catch (error) {
        // A few pre-0100 backfills use SQL the local engine does not parse yet.
        if (own.has(statement.trim())) throw error;
      }
    }
    await database.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_t', 'Kurta', 'kurta', 80000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, cost_minor)
        VALUES ('var_t', 'prod_t', 'KURTA-T', 80000, 0, 0, 1, 1, 1, 30000);
    `);
    await database.exec(`INSERT INTO inventory_movements (${MOVEMENT_COLUMNS})
      VALUES ('mv_t', 'var_t', 'received', 4, 0, 4, 2, 'regular', 1, 2, 4, 0, 0, 0, 0, 0, 0, 'loc_default')`);
    expect(await database.prepare("SELECT on_hand FROM inventory_levels WHERE variant_id = 'var_t'").get()).toEqual({ on_hand: 4 });
    await expect(database.exec(`INSERT INTO inventory_movements (${MOVEMENT_COLUMNS})
      VALUES ('mv_bad', 'var_t', 'transfer_out', 4, 4, 0, 2, 'regular', 2, 3, -4, 0, 0, 0, 0, 0, 0, 'loc_default')`)).rejects.toThrow(/semantics/);
    await expect(database.exec("UPDATE product_variants SET cost_minor = -2 WHERE id = 'var_t'")).rejects.toThrow(/PRODUCT_VARIANT_COST_INVALID/);
    await database.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status) VALUES ('ord_t', 'A', '+8801711111111', 'House', 'c', 'z', 'pending');
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor) VALUES ('item_t', 'ord_t', 'prod_t', 'var_t', 1, 'Kurta', 80000);
      INSERT INTO purchase_orders (id, number, destination_location_id, currency_code, status) VALUES ('po_t', 1001, 'loc_default', 'BDT', 'ordered');
    `);
    expect(await database.prepare("SELECT unit_cost_minor FROM order_items WHERE id = 'item_t'").get()).toEqual({ unit_cost_minor: 30000 });
    await expect(database.exec(`INSERT INTO purchase_order_lines (id, purchase_order_id, variant_id, quantity, unit_cost_minor)
      VALUES ('pol_t', 'po_t', 'var_t', 1, 1)`)).rejects.toThrow(/PURCHASE_ORDER_LINES_LOCKED/);
    await database.close();
  }, 120_000);
});
