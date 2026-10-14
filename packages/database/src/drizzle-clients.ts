/**
 * Drizzle clients over one relational schema per isolate.
 *
 * `drizzle(client, { schema })` derives the relational view of the schema (the
 * `db.query` API) on every call: about 1.3 ms of CPU over 200 tables, and
 * 15 ms the first time. A storefront batch builds a client for every part, so
 * a page paid it several times. The view comes only from the immutable schema
 * module, never from a binding or a store, so one copy serves every request.
 * These functions build what `drizzle()` builds, with that copy
 * (drizzle-clients.test.ts holds them to drizzle's own output).
 */
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm";
import { DrizzleD1Database, SQLiteD1Session } from "drizzle-orm/d1";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  SqliteRemoteDatabase,
  SQLiteRemoteSession,
  type AsyncBatchRemoteCallback,
  type AsyncRemoteCallback,
} from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

type RelationalSchema = {
  fullSchema: typeof schema;
  schema: ReturnType<typeof extractTablesRelationalConfig>["tables"];
  tableNamesMap: Record<string, string>;
};

let relational: RelationalSchema | undefined;

export function relationalSchema(): RelationalSchema {
  if (!relational) {
    const config = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
    relational = { fullSchema: schema, schema: config.tables, tableNamesMap: config.tableNamesMap };
  }
  return relational;
}

/** `drizzle(binding, { schema })` from drizzle-orm/d1. */
export function drizzleD1(client: D1Database): DrizzleD1Database<typeof schema> & { $client: D1Database } {
  const relations = relationalSchema();
  const dialect = new SQLiteAsyncDialect({});
  const session = new SQLiteD1Session(client, dialect, relations as never, {});
  const db = new DrizzleD1Database("async", dialect, session as never, relations as never) as DrizzleD1Database<typeof schema> & { $client: D1Database };
  db.$client = client;
  db.$cache = undefined as never;
  return db;
}

/** `drizzle(callback, batchCallback, { schema })` from drizzle-orm/sqlite-proxy. */
export function drizzleRemote(callback: AsyncRemoteCallback, batchCallback: AsyncBatchRemoteCallback): SqliteRemoteDatabase<typeof schema> {
  const relations = relationalSchema();
  const dialect = new SQLiteAsyncDialect({});
  const session = new SQLiteRemoteSession(callback, dialect, relations as never, batchCallback, {});
  const db = new SqliteRemoteDatabase("async", dialect, session as never, relations as never) as SqliteRemoteDatabase<typeof schema>;
  db.$cache = undefined as never;
  return db;
}
