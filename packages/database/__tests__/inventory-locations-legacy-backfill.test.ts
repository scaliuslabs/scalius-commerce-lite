// Migration 0102 backfills `location_id` onto past movements. Stores carry
// ledger v2 rows written before the 0065 semantics rules, which the old
// update trigger re-validated on any update, aborting the whole migration.
import { describe, expect, it } from "vitest";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const COLUMNS = `id, variant_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
  stock_version_before, stock_version_after, stock_delta,
  previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
  previous_preorder_stock, new_preorder_stock, preorder_stock_delta`;

function storeBefore0102() {
  const sqlite = createMigratedSqlite({ beforeMigration: "0102_", foreignKeys: false });
  // A row today's insert rules reject (an operation type 0065 retired),
  // written the way pre-0065 code could: consistent counter edges only.
  sqlite.exec("DROP TRIGGER `inventory_movements_ledger_v2_insert_semantics`");
  sqlite.exec(`INSERT INTO inventory_movements (${COLUMNS})
    VALUES ('legacy_v2', 'var_1', 'stocktake', 3, 5, 8, 2, 'regular', 1, 2, 3, 0, 0, 0, 0, 0, 0)`);
  // A row that satisfies today's rules.
  sqlite.exec(`INSERT INTO inventory_movements (${COLUMNS})
    VALUES ('valid_v2', 'var_1', 'adjusted', 2, 8, 10, 2, 'regular', 2, 3, 2, 0, 0, 0, 0, 0, 0)`);
  // A received return that put units back on the shelf (immutable once written);
  // its return, claim and movement evidence are outside this test, so the
  // insert-time guards and projections step aside (the update guard stays).
  const insertTriggers = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'order_return_receipt_lines' AND sql LIKE '%INSERT ON%'",
  ).all() as Array<{ name: string }>;
  for (const { name } of insertTriggers) sqlite.exec(`DROP TRIGGER \`${name}\``);
  sqlite.exec(`INSERT INTO order_return_receipt_lines (
      id, command_id, return_id, return_line_id, order_id, variant_id,
      received_quantity, restock_quantity, damaged_quantity, actor_type, inventory_movement_id
    ) VALUES ('receipt_1', 'cmd_1', 'ret_1', 'rl_1', 'ord_1', 'var_1', 1, 1, 0, 'admin', 'valid_v2')`);
  return sqlite;
}

describe("0102 location backfill over legacy ledger rows", () => {
  it("applies over pre-0065 v2 rows and books their location", () => {
    const sqlite = storeBefore0102();
    expect(() => sqlite.exec(compiledMigrationSql("d1", undefined, "0102_"))).not.toThrow();
    const rows = sqlite.prepare("SELECT id, location_id FROM inventory_movements ORDER BY id").all();
    expect(rows).toEqual([
      { id: "legacy_v2", location_id: "loc_default" },
      { id: "valid_v2", location_id: "loc_default" },
    ]);
    expect(sqlite.prepare("SELECT restock_location_id FROM order_return_receipt_lines").get())
      .toEqual({ restock_location_id: "loc_default" });
    // The receipt guard is back after the backfill.
    expect(() => sqlite.exec("UPDATE order_return_receipt_lines SET restock_quantity = 0"))
      .toThrow(/return receipt dispositions are immutable/);
  });

  it("still rejects a change to a movement's operation, and allows a note", () => {
    const sqlite = storeBefore0102();
    sqlite.exec(compiledMigrationSql("d1", undefined, "0102_"));
    expect(() => sqlite.exec("UPDATE inventory_movements SET type = 'reserved' WHERE id = 'valid_v2'"))
      .toThrow(/invalid inventory ledger v2 operation semantics/);
    expect(() => sqlite.exec("UPDATE inventory_movements SET notes = 'counted twice' WHERE id = 'legacy_v2'"))
      .not.toThrow();
  });
});
