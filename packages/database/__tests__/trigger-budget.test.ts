import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createMigratedSqlite } from "../src/testing/sqlite-d1";

/**
 * The trigger budget. Every row a trigger writes is a row the buyer's write pays for ($1 a million on D1),
 * so synchronous projections must not creep back into the write path: a trigger body stays small, a write
 * event (a table's insert, update or delete) runs a bounded number of write statements, and a table gains
 * no triggers beyond the recorded count. Raising a number is a decision: say why in the commit message.
 *
 *   TRIGGER_BUDGET_RECORD=1 pnpm exec vitest run packages/database/__tests__/trigger-budget.test.ts
 *
 * rewrites trigger-budget.json from the migrated schema (D1 and Turso run the same SQLite triggers).
 */
const budgetFile = join(dirname(fileURLToPath(import.meta.url)), "trigger-budget.json");

interface TriggerBudget {
  /** Bytes of the longest single trigger definition. */
  maxBytes: number;
  /** Write statements (INSERT, UPDATE, DELETE) of the heaviest single trigger. */
  maxWritesPerTrigger: number;
  /** Write statements all triggers of one table event run together (the heaviest event). */
  maxWritesPerEvent: number;
  total: number;
  tables: Record<string, number>;
}

interface Measured extends TriggerBudget {
  longest: string;
  heaviestEvent: string;
}

/** Count write statements, ignoring the words inside string literals and comments. */
function writeStatements(sql: string): number {
  const code = sql.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");
  const writes = code.match(/\b(?:insert|update|delete)\b/gi) ?? [];
  // `ON CONFLICT DO UPDATE` and the `AFTER UPDATE [OF ...]` header are part of a statement, not a statement.
  const upserts = code.match(/\bdo\s+update\b/gi) ?? [];
  const header = code.match(/\b(?:after|before|instead\s+of)\s+(?:insert|update|delete)\b/gi) ?? [];
  return Math.max(0, writes.length - upserts.length - header.length);
}

function measure(): Measured {
  const sqlite = createMigratedSqlite();
  try {
    const triggers = sqlite.prepare("SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; tbl: string; sql: string }>;
    const tables: Record<string, number> = {};
    const events = new Map<string, number>();
    let maxBytes = 0, longest = "", maxWritesPerTrigger = 0;
    for (const { name, tbl, sql } of triggers) {
      tables[tbl] = (tables[tbl] ?? 0) + 1;
      if (sql.length > maxBytes) [maxBytes, longest] = [sql.length, name];
      const writes = writeStatements(sql);
      maxWritesPerTrigger = Math.max(maxWritesPerTrigger, writes);
      // A trigger names its events once: `AFTER INSERT ON t`, `AFTER UPDATE OF a, b ON t`.
      const event = /\b(?:after|before|instead\s+of)\s+(insert|update|delete)\b/i.exec(sql)?.[1]?.toLowerCase() ?? "?";
      const key = `${tbl}:${event}`;
      events.set(key, (events.get(key) ?? 0) + writes);
    }
    const [heaviestEvent = "", maxWritesPerEvent = 0] = [...events.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    return {
      maxBytes, maxWritesPerTrigger, maxWritesPerEvent, total: triggers.length,
      tables: Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))),
      longest, heaviestEvent,
    };
  } finally {
    sqlite.close();
  }
}

const measured = measure();

if (process.env.TRIGGER_BUDGET_RECORD === "1") {
  // Byte and statement limits carry headroom (a trigger may grow a little); counts are exact.
  const { longest: _l, heaviestEvent: _h, ...counts } = measured;
  const budget: TriggerBudget = { ...counts, maxBytes: Math.ceil(measured.maxBytes / 100) * 100 };
  writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
}

const budget = JSON.parse(readFileSync(budgetFile, "utf8")) as TriggerBudget;

describe("trigger budget", () => {
  it("keeps every trigger definition small", () => {
    expect(measured.maxBytes, `${measured.longest} is the longest trigger`).toBeLessThanOrEqual(budget.maxBytes);
  });

  it("keeps the write statements of one trigger and of one table event bounded", () => {
    expect(measured.maxWritesPerTrigger).toBeLessThanOrEqual(budget.maxWritesPerTrigger);
    expect(measured.maxWritesPerEvent, `${measured.heaviestEvent} runs the most trigger writes`).toBeLessThanOrEqual(budget.maxWritesPerEvent);
  });

  it("adds no trigger to a table beyond its recorded count", () => {
    const grown = Object.entries(measured.tables)
      .filter(([table, count]) => count > (budget.tables[table] ?? 0))
      .map(([table, count]) => `${table}: ${budget.tables[table] ?? 0} -> ${count}`);
    expect(grown, "tables that gained triggers").toEqual([]);
    expect(measured.total).toBeLessThanOrEqual(budget.total);
  });

  it("counts write statements without counting upserts, UPDATE OF headers or string literals twice", () => {
    expect(writeStatements("CREATE TRIGGER t AFTER UPDATE OF a ON x BEGIN UPDATE y SET a = 1; END")).toBe(1);
    expect(writeStatements("CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO y VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 2; END")).toBe(1);
    expect(writeStatements("CREATE TRIGGER t AFTER DELETE ON x BEGIN INSERT INTO y VALUES ('delete update insert'); DELETE FROM z; END")).toBe(2);
  });
});
