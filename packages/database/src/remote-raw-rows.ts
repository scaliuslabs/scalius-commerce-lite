import { sql, type SQLWrapper } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { SQLiteRaw } from "drizzle-orm/sqlite-core/query-builders/raw";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

interface NamedRemoteResult {
  rows: unknown[];
  columns?: readonly (string | undefined)[];
}

function namedRows(result: NamedRemoteResult): Record<string, unknown>[] {
  return result.rows.map((row) => {
    if (!Array.isArray(row) || result.columns?.length !== row.length) {
      throw new Error("Remote raw query returned rows without matching column names.");
    }
    return Object.fromEntries(row.map((value, index) => {
      const name = result.columns![index];
      if (name === undefined) throw new Error("Remote raw query returned a nameless column.");
      return [name, value];
    }));
  });
}

/** Raw all/get match D1's objects; mapped builders and values retain positional rows. */
export function withNamedRawRows<TSchema extends Record<string, unknown>>(
  db: SqliteRemoteDatabase<TSchema>,
  execute: (sql: string, params: unknown[], method: "all") => Promise<NamedRemoteResult>,
): SqliteRemoteDatabase<TSchema> {
  const dialect = new SQLiteAsyncDialect();
  const raw = <T>(input: SQLWrapper | string, method: "all" | "get") => {
    const query = typeof input === "string" ? sql.raw(input) : input.getSQL();
    const map = (result: unknown) => {
      const rows = namedRows(result as NamedRemoteResult);
      return (method === "get" ? rows[0] : rows) as T;
    };
    return new SQLiteRaw<T>(async () => {
      const built = dialect.sqlToQuery(query);
      return map(await execute(built.sql, built.params, "all"));
    }, () => query, method, dialect, map);
  };
  db.all = <T = unknown>(query: SQLWrapper | string) => raw<T[]>(query, "all");
  db.get = <T = unknown>(query: SQLWrapper | string) => raw<T>(query, "get");
  return db;
}
