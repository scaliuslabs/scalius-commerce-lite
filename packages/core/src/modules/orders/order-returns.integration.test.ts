import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";

import {
  approveOrderReturn,
  cancelOrderReturn,
  receiveOrderReturn,
} from "./order-returns";

type ProxyMethod = "run" | "all" | "values" | "get";
type ProxyQuery = { sql: string; params: unknown[]; method: ProxyMethod };

function queryRows(sqlite: DatabaseSync, query: ProxyQuery) {
  let statement;
  try {
    statement = sqlite.prepare(query.sql);
  } catch (error) {
    throw new Error(
      `Failed to prepare return transaction SQL: ${query.sql}`,
      { cause: error },
    );
  }
  statement.setReturnArrays(true);
  const params = query.params as SQLInputValue[];
  if (query.method === "run") {
    statement.run(...params);
    return [];
  }
  if (query.method === "get") {
    return statement.get(...params) as unknown as unknown[];
  }
  return statement.all(...params) as unknown as unknown[][];
}

function createReturnDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      inventory_pool TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE order_returns (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      status TEXT DEFAULT 'requested' NOT NULL,
      reason TEXT NOT NULL,
      notes TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      source TEXT DEFAULT 'admin' NOT NULL,
      source_reference_id TEXT,
      version INTEGER DEFAULT 1 NOT NULL,
      active_order_key TEXT,
      active_command_key TEXT,
      active_command_hash TEXT,
      active_command_type TEXT,
      active_command_started_at INTEGER,
      requested_at INTEGER NOT NULL,
      approved_at INTEGER,
      receiving_started_at INTEGER,
      completed_at INTEGER,
      rejected_at INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX order_returns_active_order_key_unique
      ON order_returns(active_order_key);

    CREATE TABLE order_return_lines (
      id TEXT PRIMARY KEY NOT NULL,
      return_id TEXT NOT NULL REFERENCES order_returns(id) ON DELETE RESTRICT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      order_item_id TEXT NOT NULL,
      variant_id TEXT,
      inventory_tracked INTEGER DEFAULT 1 NOT NULL,
      requested_quantity INTEGER NOT NULL,
      approved_quantity INTEGER DEFAULT 0 NOT NULL,
      received_quantity INTEGER DEFAULT 0 NOT NULL,
      restock_quantity INTEGER DEFAULT 0 NOT NULL,
      damaged_quantity INTEGER DEFAULT 0 NOT NULL,
      rejected_quantity INTEGER DEFAULT 0 NOT NULL,
      reason TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (approved_quantity + rejected_quantity <= requested_quantity),
      CHECK (
        received_quantity <= approved_quantity
        AND restock_quantity + damaged_quantity = received_quantity
      )
    );

    CREATE TABLE order_items (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL,
      fulfillment_status TEXT NOT NULL
    );

    CREATE TABLE order_return_commands (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      return_id TEXT NOT NULL REFERENCES order_returns(id) ON DELETE RESTRICT,
      command_key TEXT NOT NULL,
      command_type TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_payload TEXT,
      status TEXT DEFAULT 'processing' NOT NULL,
      response_payload TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (length(trim(command_key)) BETWEEN 8 AND 200),
      CHECK (
        status <> 'processing'
        OR (command_type = 'receive' AND request_payload IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX order_return_commands_order_key_unique
      ON order_return_commands(order_id, command_key);

    CREATE TABLE order_return_receipt_lines (
      id TEXT PRIMARY KEY NOT NULL,
      command_id TEXT NOT NULL REFERENCES order_return_commands(id) ON DELETE RESTRICT,
      return_id TEXT NOT NULL REFERENCES order_returns(id) ON DELETE RESTRICT,
      return_line_id TEXT NOT NULL REFERENCES order_return_lines(id) ON DELETE RESTRICT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      variant_id TEXT,
      received_quantity INTEGER NOT NULL,
      restock_quantity INTEGER NOT NULL,
      damaged_quantity INTEGER NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      inventory_movement_id TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      CHECK (received_quantity > 0),
      CHECK (restock_quantity + damaged_quantity = received_quantity),
      CHECK (
        (restock_quantity = 0 AND inventory_movement_id IS NULL)
        OR (restock_quantity > 0 AND inventory_movement_id IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX order_return_receipt_lines_command_line_unique
      ON order_return_receipt_lines(command_id, return_line_id);

    CREATE TRIGGER order_return_receipt_lines_project_after_insert
    AFTER INSERT ON order_return_receipt_lines
    BEGIN
      UPDATE order_return_lines
      SET received_quantity = received_quantity + NEW.received_quantity,
          restock_quantity = restock_quantity + NEW.restock_quantity,
          damaged_quantity = damaged_quantity + NEW.damaged_quantity,
          updated_at = unixepoch()
      WHERE id = NEW.return_line_id;
    END;

    CREATE TRIGGER order_returns_validate_status_update
    BEFORE UPDATE OF status ON order_returns
    WHEN NOT (
      OLD.status = NEW.status
      OR (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
      OR (OLD.status = 'approved' AND NEW.status IN ('receiving', 'completed', 'cancelled'))
      OR (OLD.status = 'receiving' AND NEW.status IN ('receiving', 'completed'))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid return lifecycle transition');
    END;

    INSERT INTO orders (id, status, version, inventory_pool, updated_at)
      VALUES ('order_1', 'shipped', 5, 'primary', 1);
    INSERT INTO order_returns (
      id, order_id, status, reason, notes, actor_type, actor_id, source,
      source_reference_id, version, requested_at, created_at, updated_at
    ) VALUES (
      'return_1', 'order_1', 'requested', 'Changed mind', NULL, 'admin',
      'admin_1', 'admin', NULL, 1, 1, 1, 1
    );
    INSERT INTO order_return_lines (
      id, return_id, order_id, order_item_id, variant_id, inventory_tracked,
      requested_quantity, approved_quantity, received_quantity,
      restock_quantity, damaged_quantity, rejected_quantity, reason, notes,
      created_at, updated_at
    ) VALUES (
      'line_1', 'return_1', 'order_1', 'item_1', 'variant_1', 1,
      1, 0, 0, 0, 0, 0, NULL, NULL, 1, 1
    );
    INSERT INTO order_items (id, order_id, quantity, fulfillment_status)
      VALUES ('item_1', 'order_1', 1, 'shipped');
  `);

  const execute = async (sql: string, params: unknown[], method: ProxyMethod) => ({
    rows: queryRows(sqlite, { sql, params, method }),
  });
  const batch = async (queries: ProxyQuery[]) => {
    sqlite.exec("BEGIN");
    try {
      const results = queries.map((query) => ({ rows: queryRows(sqlite, query) }));
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    sqlite,
    db: drizzle(execute, batch, { schema }) as unknown as Database,
  };
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
});
