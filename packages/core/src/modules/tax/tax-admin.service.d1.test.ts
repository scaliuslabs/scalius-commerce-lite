import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { ConflictError } from "@scalius/core/errors";
import { deleteTaxRate, updateTaxRate } from "./tax-admin.service";

describe("tax lifecycle D1 atomicity", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase() {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    return harness.db;
  }

  function seedEnabledTax(rateIds: string[]) {
    sqlite!.exec(`
      INSERT INTO tax_classes
        (id, name, description, is_exempt, version, created_at, updated_at, deleted_at)
      VALUES ('taxc_standard', 'Standard', NULL, 0, 1, 1, 1, NULL);
      INSERT INTO tax_settings
        (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id,
         shipping_tax_class_id, display_label, version, created_at, updated_at)
      VALUES ('default', 1, 0, 0, 'taxc_standard', NULL, 'Tax', 1, 1, 1);
    `);
    const insertRate = sqlite!.prepare(`
      INSERT INTO tax_rates
        (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id,
         jurisdiction_label, priority, is_compound, is_active, version,
         created_at, updated_at, deleted_at)
      VALUES (?, 'taxc_standard', ?, 1500, 'all', NULL, NULL, 0, 0, 1, 1, 1, 1, NULL)
    `);
    for (const id of rateIds) insertRate.run(id, id);
  }

  it("rolls back the actual post-state mutation that would remove final coverage", async () => {
    const db = createDatabase();
    seedEnabledTax(["taxr_last"]);

    await expect(updateTaxRate(db, "taxr_last", {
      expectedVersion: 1,
      isActive: false,
    })).rejects.toBeInstanceOf(ConflictError);

    expect(sqlite!.prepare(`
      SELECT is_active AS isActive, version, deleted_at AS deletedAt
      FROM tax_rates WHERE id = 'taxr_last'
    `).get()).toEqual({ isActive: 1, version: 1, deletedAt: null });
  });

  it("serializes concurrent removals and rejects a stale final-rate delete", async () => {
    const db = createDatabase();
    seedEnabledTax(["taxr_a", "taxr_b"]);

    const outcomes = await Promise.allSettled([
      updateTaxRate(db, "taxr_a", { expectedVersion: 1, isActive: false }),
      updateTaxRate(db, "taxr_b", { expectedVersion: 1, isActive: false }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
    const activeRate = sqlite!.prepare(`
      SELECT id, version FROM tax_rates
      WHERE is_active = 1 AND deleted_at IS NULL
    `).get() as { id: string; version: number };
    expect(sqlite!.prepare(`
      SELECT count(*) AS count FROM tax_rates
      WHERE is_active = 1 AND deleted_at IS NULL
    `).get()).toEqual({ count: 1 });

    const changed = await updateTaxRate(db, activeRate.id, {
      expectedVersion: activeRate.version,
      rateBps: 1_600,
    });
    await expect(deleteTaxRate(db, activeRate.id, activeRate.version))
      .rejects.toBeInstanceOf(ConflictError);

    expect(sqlite!.prepare(`
      SELECT is_active AS isActive, version, deleted_at AS deletedAt
      FROM tax_rates WHERE id = ?
    `).get(activeRate.id)).toEqual({
      isActive: 1,
      version: changed.version,
      deletedAt: null,
    });
  });
});
