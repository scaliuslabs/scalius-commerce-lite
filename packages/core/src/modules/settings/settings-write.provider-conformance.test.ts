import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";

import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPostgresDatabase,
  createTursoDatabase,
  type Database,
} from "@scalius/database/client";
import * as schema from "@scalius/database/schema";

import { saveSettingAggregate } from "./settings-write";

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

const sqliteDatabases: DatabaseSync[] = [];

function rows(statement: StatementSync, values: SQLInputValue[]) {
  return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function d1Statement(
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
    bind: (...nextValues) => d1Statement(sqlite, query, nextValues),
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

function createSettingsSchema() {
  const sqlite = new DatabaseSync(":memory:");
  sqliteDatabases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE settings (
      id TEXT PRIMARY KEY NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'string',
      category TEXT NOT NULL DEFAULT 'general',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER,
      UNIQUE(key, category)
    );
  `);
  return sqlite;
}

function createD1SettingsDatabase(sqlite: DatabaseSync): Database {
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return drizzle(binding, { schema }) as unknown as Database;
}

function createTursoSettingsDatabase(sqlite: DatabaseSync): Database {
  return createTursoDatabase(
    { url: "turso://settings-conformance.turso.io", authToken: "test" },
    {
      connect: () => ({
        async batch(statements, options) {
          const transactional = options?.mode !== undefined;
          if (transactional) sqlite.exec("BEGIN IMMEDIATE");
          try {
            const results = statements.map((statement) => {
              const sqlText = typeof statement === "string" ? statement : statement.sql;
              const args = typeof statement === "string" || statement.args === undefined
                ? []
                : statement.args;
              if (!Array.isArray(args)) throw new Error("Positional arguments are required.");
              const prepared = sqlite.prepare(sqlText);
              if (prepared.columns().length === 0) {
                const result = prepared.run(...args as SQLInputValue[]);
                return { rows: [], rowsAffected: Number(result.changes) };
              }
              prepared.setReturnArrays(true);
              return {
                rows: prepared.all(...args as SQLInputValue[]) as unknown as SQLOutputValue[][],
                rowsAffected: 0,
              };
            });
            if (transactional) sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            if (transactional && sqlite.isTransaction) sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      }),
      writeBatchMode: "concurrent",
    },
  );
}

function storedValue(sqlite: DatabaseSync, key: string): string | undefined {
  return sqlite.prepare(
    "SELECT value FROM settings WHERE category = 'stripe' AND key = ?",
  ).get(key)?.value as string | undefined;
}

afterEach(() => {
  while (sqliteDatabases.length > 0) sqliteDatabases.pop()?.close();
});

describe.each([
  ["D1", createD1SettingsDatabase],
  ["TursoDB", createTursoSettingsDatabase],
] as const)("%s settings aggregate conformance", (_provider, createDatabase) => {
  it("commits the whole form and rolls back every field when one statement fails", async () => {
    const sqlite = createSettingsSchema();
    const db = createDatabase(sqlite);

    await saveSettingAggregate(db, [
      { category: "stripe", key: "enabled", value: "false" },
      { category: "stripe", key: "publishable_key", value: "pk_test_one" },
    ]);
    expect(storedValue(sqlite, "enabled")).toBe("false");
    expect(storedValue(sqlite, "publishable_key")).toBe("pk_test_one");

    sqlite.exec(`
      CREATE TRIGGER reject_blocked_setting
      BEFORE INSERT ON settings
      WHEN NEW.key = 'blocked_key'
      BEGIN
        SELECT RAISE(ABORT, 'blocked settings write');
      END;
    `);

    await expect(saveSettingAggregate(db, [
      { category: "stripe", key: "enabled", value: "true" },
      { category: "stripe", key: "blocked_key", value: "must-not-commit" },
    ])).rejects.toThrow();

    expect(storedValue(sqlite, "enabled")).toBe("false");
    expect(storedValue(sqlite, "blocked_key")).toBeUndefined();
  });
});

describe("PostgreSQL settings aggregate conformance", () => {
  it("submits the whole form through one serializable transaction", async () => {
    const emptyResult = { rows: [], fields: [] };
    const query = vi.fn(() => Promise.resolve(emptyResult));
    const transaction = vi.fn(async (queries: PromiseLike<typeof emptyResult>[]) =>
      await Promise.all(queries));
    const db = createPostgresDatabase(
      "postgresql://user:secret@example.neon.tech/settings",
      { connect: () => ({ query, transaction }) },
    );

    await saveSettingAggregate(db, [
      { category: "stripe", key: "enabled", value: "true" },
      { category: "stripe", key: "publishable_key", value: "pk_live_value" },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
      arrayMode: true,
      fullResults: true,
      isolationLevel: "Serializable",
      readOnly: false,
    });
  });

  it("propagates a PostgreSQL transaction failure instead of treating fields as saved", async () => {
    const emptyResult = { rows: [], fields: [] };
    const query = vi.fn(() => Promise.resolve(emptyResult));
    const transaction = vi.fn(async () => {
      throw new Error("transaction rolled back");
    });
    const db = createPostgresDatabase(
      "postgresql://user:secret@example.neon.tech/settings",
      { connect: () => ({ query, transaction }) },
    );

    await expect(saveSettingAggregate(db, [
      { category: "email", key: "email_provider", value: "resend" },
      { category: "email", key: "email_sender", value: "orders@example.com" },
    ])).rejects.toThrow("transaction rolled back");
    expect(transaction).toHaveBeenCalledOnce();
  });
});
