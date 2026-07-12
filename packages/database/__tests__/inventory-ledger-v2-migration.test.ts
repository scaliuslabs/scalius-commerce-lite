import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../migrations");
const additiveMigration = readFileSync(
  resolve(migrationsDirectory, "0003_aberrant_hex.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const validationMigration = readFileSync(
  resolve(migrationsDirectory, "0004_validate_inventory_ledger_v2.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const movementFilterIndexMigration = readFileSync(
  resolve(migrationsDirectory, "0009_sticky_green_goblin.sql"),
  "utf8",
);

const legacyTable = `
  CREATE TABLE inventory_movements (
    id TEXT PRIMARY KEY NOT NULL,
    variant_id TEXT NOT NULL,
    order_id TEXT,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    previous_stock INTEGER NOT NULL,
    new_stock INTEGER NOT NULL,
    notes TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

function execute(sql: string) {
  return spawnSync("sqlite3", [":memory:"], {
    input: `.bail on\n${legacyTable}\n${additiveMigration}\n${validationMigration}\n${sql}`,
    encoding: "utf8",
  });
}

const validV2Values = `
  'v2_1', 'variant_1', 'order_1', 'preorder_reserved', 2, 10, 10, 'reserve', NULL,
  2, 'preorder', 1, 4, 5, 0, 0, 2, 2, 5, 3, -2, unixepoch()
`;

describe("inventory ledger v2 migrations", () => {
  it("indexes movement type and time for bounded audit-history filtering", () => {
    expect(movementFilterIndexMigration).toContain(
      "CREATE INDEX `inventory_movements_type_created_at_idx` ON `inventory_movements` (`type`,`created_at`)",
    );
  });

  it("adds columns and indexes without rebuilding or deleting legacy movement history", () => {
    expect(additiveMigration).toContain("ALTER TABLE `inventory_movements` ADD `ledger_version`");
    expect(additiveMigration).not.toMatch(/DROP TABLE|__new_inventory_movements/i);

    const result = execute(`
      INSERT INTO inventory_movements (
        id, variant_id, type, quantity, previous_stock, new_stock
      ) VALUES ('legacy_1', 'variant_1', 'adjusted', 1, 0, 1);
      SELECT ledger_version FROM inventory_movements WHERE id = 'legacy_1';
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("1");
  });

  it("accepts a complete v2 edge and rejects a mismatched counter delta", () => {
    const valid = execute(`
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock,
        notes, created_by, ledger_version, pool, reservation_generation,
        stock_version_before, stock_version_after, stock_delta,
        previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
        previous_preorder_stock, new_preorder_stock, preorder_stock_delta,
        created_at
      ) VALUES (${validV2Values});
    `);
    expect(valid.status, valid.stderr).toBe(0);

    const invalid = execute(`
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock,
        notes, created_by, ledger_version, pool, reservation_generation,
        stock_version_before, stock_version_after, stock_delta,
        previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
        previous_preorder_stock, new_preorder_stock, preorder_stock_delta,
        created_at
      ) VALUES (
        'v2_bad', 'variant_1', 'order_1', 'reserved', 2, 10, 10, 'reserve', NULL,
        2, 'regular', 1, 4, 5, 1, 0, 2, 2, 0, 0, 0, unixepoch()
      );
    `);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("invalid inventory ledger v2");
  });

  it("enforces one ledger edge per SKU stock-version transition", () => {
    const result = execute(`
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock,
        notes, created_by, ledger_version, pool, reservation_generation,
        stock_version_before, stock_version_after, stock_delta,
        previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
        previous_preorder_stock, new_preorder_stock, preorder_stock_delta,
        created_at
      ) VALUES (${validV2Values});
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock,
        notes, created_by, ledger_version, pool, reservation_generation,
        stock_version_before, stock_version_after, stock_delta,
        previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
        previous_preorder_stock, new_preorder_stock, preorder_stock_delta,
        created_at
      ) VALUES (
        'v2_2', 'variant_1', 'order_2', 'adjusted', 0, 10, 10, 'duplicate edge', NULL,
        2, 'regular', NULL, 4, 5, 0, 2, 2, 0, 3, 3, 0, unixepoch()
      );
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("UNIQUE constraint failed");
  });

  it("rejects counter transitions that contradict the movement type and pool", () => {
    const result = execute(`
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock,
        notes, created_by, ledger_version, pool, reservation_generation,
        stock_version_before, stock_version_after, stock_delta,
        previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
        previous_preorder_stock, new_preorder_stock, preorder_stock_delta,
        created_at
      ) VALUES (
        'v2_impossible', 'variant_1', 'order_1', 'reserved', 2, 10, 8, 'bad reserve', NULL,
        2, 'regular', 1, 4, 5, -2, 0, 2, 2, 0, 0, 0, unixepoch()
      );
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid inventory ledger v2 operation semantics");
  });
});
