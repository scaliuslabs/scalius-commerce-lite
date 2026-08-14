import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDailyActivityData } from "./dashboard.service";

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

function rows(statement: StatementSync, values: SQLInputValue[]) {
  return statement.all(...values);
}

function createStatement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: rows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...nextValues) => createStatement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = rows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createDatabase(sqlite: DatabaseSync): Database {
  const binding = {
    prepare: (query: string) => createStatement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      return statements.map((statement) => statement.execute());
    },
  };
  return drizzle(binding as unknown as D1Database, { schema }) as unknown as Database;
}

function epoch(value: string): number {
  return Date.parse(value) / 1000;
}

describe("dashboard merchant calendar boundaries", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    vi.setSystemTime(new Date("2026-08-14T05:30:00.000Z"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        total_amount REAL NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
    `);
    db = createDatabase(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("groups both sides of UTC midnight by the Bangladesh merchant day", async () => {
    const insertOrder = sqlite.prepare(
      "INSERT INTO orders (id, total_amount, status, created_at) VALUES (?, ?, 'processing', ?)",
    );
    insertOrder.run("before_boundary", 100, epoch("2026-08-13T17:59:59.000Z"));
    insertOrder.run("after_boundary", 200, epoch("2026-08-13T18:00:00.000Z"));
    insertOrder.run("after_utc_midnight", 300, epoch("2026-08-14T00:30:00.000Z"));
    sqlite.prepare("INSERT INTO customers (id, created_at) VALUES (?, ?)")
      .run("customer_today", epoch("2026-08-13T18:00:01.000Z"));

    const activity = await getDailyActivityData(db, 2);

    expect(activity).toHaveLength(2);
    expect(activity).toEqual([
      { date: "2026-08-13", orders: 1, revenue: 100, newCustomers: 0 },
      { date: "2026-08-14", orders: 2, revenue: 500, newCustomers: 1 },
    ]);
  });

  it("returns exactly the requested number of rows including today", async () => {
    const activity = await getDailyActivityData(db, 90);

    expect(activity).toHaveLength(90);
    expect(activity[0]?.date).toBe("2026-05-17");
    expect(activity.at(-1)?.date).toBe("2026-08-14");
  });
});
