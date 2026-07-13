import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";

import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";

import { ConflictError } from "@scalius/core/errors";
import { deleteTaxRate, updateTaxRate } from "./tax-admin.service";

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function resultRows(
  statement: StatementSync,
  values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
  return statement.all(...values);
}

function createD1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: resultRows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });

  return {
    bind: (...nextValues) => createD1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = resultRows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

describe("tax lifecycle D1 atomicity", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase() {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE tax_classes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        is_exempt INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE tax_settings (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        prices_include_tax INTEGER NOT NULL DEFAULT 0,
        tax_shipping INTEGER NOT NULL DEFAULT 0,
        default_tax_class_id TEXT,
        shipping_tax_class_id TEXT,
        display_label TEXT NOT NULL DEFAULT 'Tax',
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tax_rates (
        id TEXT PRIMARY KEY,
        tax_class_id TEXT NOT NULL,
        name TEXT NOT NULL,
        rate_bps INTEGER NOT NULL,
        jurisdiction_type TEXT NOT NULL,
        jurisdiction_id TEXT,
        jurisdiction_label TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        is_compound INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
    `);

    const client = {
      prepare: (query: string) => createD1Statement(sqlite!, query),
      batch: async (statements: SqliteD1Statement[]) => {
        sqlite!.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite!.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite!.exec("ROLLBACK");
          throw error;
        }
      },
    };
    return drizzle(client as unknown as D1Database, { schema });
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
