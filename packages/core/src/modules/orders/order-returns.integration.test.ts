import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import {
  approveOrderReturn,
  cancelOrderReturn,
  getOrderReturn,
  receiveOrderReturn,
} from "./order-returns";

function createReturnDatabase() {
  const fixture = createSqliteD1Database({ foreignKeys: true });
  fixture.sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor) VALUES ('product_1', 'Returned product', 'returned-product', 10000);
    INSERT INTO product_variants (id, product_id, sku, price_minor, is_default)
      VALUES ('variant_1', 'product_1', 'RETURN-SKU', 10000, 1);
    INSERT INTO orders (
      id, customer_name, customer_phone, shipping_address, city, zone,
      total_amount_minor, shipping_amount_minor, status, version, inventory_pool
    ) VALUES ('order_1', 'Buyer', '+8801700000000', 'Address', 'city', 'zone', 10000, 0, 'shipped', 5, 'regular');
    INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, shipped_quantity, unit_price_minor, fulfillment_status)
      VALUES ('item_1', 'order_1', 'product_1', 'variant_1', 1, 1, 10000, 'shipped');
    INSERT INTO order_returns (id, order_id, status, reason, actor_type, actor_id, version)
      VALUES ('return_1', 'order_1', 'requested', 'Changed mind', 'admin', 'admin_1', 1);
    INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, variant_id, requested_quantity)
      VALUES ('line_1', 'return_1', 'order_1', 'item_1', 'variant_1', 1);
  `);
  return fixture;
}

describe("item-level return database transactions", () => {
  let sqlite: DatabaseSync | undefined;

  afterEach(() => sqlite?.close());

  it("approves every return line in one guarded batch", async () => {
    const fixture = createReturnDatabase();
    sqlite = fixture.sqlite;

    const result = await approveOrderReturn(
      fixture.db,
      "order_1",
      "return_1",
      {
        commandKey: "approve-command-1",
        expectedVersion: 1,
        notes: "Approved by QA",
        lines: [{
          lineId: "line_1",
          approvedQuantity: 1,
          rejectedQuantity: 0,
        }],
      },
      { type: "admin", id: "admin_1" },
    );

    expect(result).toMatchObject({
      orderId: "order_1",
      returnId: "return_1",
      status: "approved",
      version: 2,
      restockedQuantity: 0,
      wholeOrderReturned: false,
    });
    expect(sqlite.prepare(`
      SELECT status, version, notes FROM order_returns WHERE id = 'return_1'
    `).get()).toEqual({ status: "approved", version: 2, notes: "Approved by QA" });
    expect(sqlite.prepare(`
      SELECT approved_quantity, rejected_quantity
      FROM order_return_lines WHERE id = 'line_1'
    `).get()).toEqual({ approved_quantity: 1, rejected_quantity: 0 });
    expect(sqlite.prepare(`
      SELECT command_type, status FROM order_return_commands
      WHERE order_id = 'order_1'
    `).get()).toEqual({ command_type: "approve", status: "committed" });
  });

  it("cancels an unreceived return in one guarded batch", async () => {
    const fixture = createReturnDatabase();
    sqlite = fixture.sqlite;

    const result = await cancelOrderReturn(
      fixture.db,
      "order_1",
      "return_1",
      {
        commandKey: "cancel-command-1",
        expectedVersion: 1,
        notes: "Cancelled by QA",
      },
      { type: "admin", id: "admin_1" },
    );

    expect(result).toMatchObject({
      status: "cancelled",
      version: 2,
      restockedQuantity: 0,
      wholeOrderReturned: false,
    });
    expect(sqlite.prepare(`
      SELECT status, version, notes FROM order_returns WHERE id = 'return_1'
    `).get()).toEqual({ status: "cancelled", version: 2, notes: "Cancelled by QA" });
  });

  it("receives a damaged unit without restocking it", async () => {
    const fixture = createReturnDatabase();
    sqlite = fixture.sqlite;
    sqlite.exec(`
      UPDATE orders SET version = 6 WHERE id = 'order_1';
      UPDATE order_returns
      SET status = 'approved', version = 2, approved_at = 2
      WHERE id = 'return_1';
      UPDATE order_return_lines
      SET approved_quantity = 1
      WHERE id = 'line_1';
    `);

    const result = await receiveOrderReturn(
      fixture.db,
      "order_1",
      "return_1",
      {
        commandKey: "receive-command-1",
        expectedVersion: 2,
        notes: "Inspected by QA",
        lines: [{
          lineId: "line_1",
          receivedQuantity: 1,
          restockQuantity: 0,
          damagedQuantity: 1,
          notes: "Damaged in transit",
        }],
      },
      { type: "admin", id: "admin_1" },
    );

    expect(result).toMatchObject({
      status: "completed",
      version: 3,
      restockedQuantity: 0,
      wholeOrderReturned: true,
    });
    expect(sqlite.prepare(`
      SELECT status, version, active_command_key
      FROM order_returns WHERE id = 'return_1'
    `).get()).toEqual({ status: "completed", version: 3, active_command_key: null });
    expect(sqlite.prepare(`
      SELECT received_quantity, restock_quantity, damaged_quantity
      FROM order_return_lines WHERE id = 'line_1'
    `).get()).toEqual({
      received_quantity: 1,
      restock_quantity: 0,
      damaged_quantity: 1,
    });
    expect(sqlite.prepare(`
      SELECT status, version FROM orders WHERE id = 'order_1'
    `).get()).toEqual({ status: "returned", version: 8 });
  });

  it("exposes an interrupted receipt only as a sanitized recovery flag", async () => {
    const fixture = createReturnDatabase();
    sqlite = fixture.sqlite;
    sqlite.exec(`UPDATE order_returns SET status = 'approved', version = 2,
      active_command_key = 'private-receive-command', active_command_hash = 'private-hash',
      active_command_type = 'receive', active_command_started_at = 123 WHERE id = 'return_1'`);

    const view = await getOrderReturn(fixture.db, "order_1", "return_1");

    expect(view.receiptRecovery).toEqual({ required: true, startedAt: 123 });
    expect(JSON.stringify(view)).not.toMatch(/private-receive-command|private-hash/);
  });
});
