/**
 * What the row-mutation generator knows about the schema: every real table of
 * the migrated database (PRAGMA truth: columns, primary key, foreign keys) and,
 * from the Drizzle schema, each column's value shape (enum, boolean, epoch
 * timestamp, JSON). CHECK constraints and triggers stay opaque: the generator
 * proposes values and the database is the judge.
 */
import type { DatabaseSync } from "node:sqlite";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@scalius/database/schema";
import {
  CACHE_DEP_TABLES,
  cacheDepExemptReason,
  isCacheDepTable,
} from "@scalius/shared/cache-deps";

export type ColumnShape = "text" | "integer" | "real" | "boolean" | "timestamp" | "json" | "blob";

export interface ColumnModel {
  readonly name: string;
  readonly declaredType: string;
  readonly shape: ColumnShape;
  readonly notNull: boolean;
  /** 1-based position in the primary key, 0 when not part of it. */
  readonly pk: number;
  readonly enumValues: readonly string[] | null;
  readonly references: { readonly table: string; readonly column: string } | null;
  /** Registry noise column of a registered table. */
  readonly noise: boolean;
}

export interface TableModel {
  readonly name: string;
  readonly columns: readonly ColumnModel[];
  readonly pkColumns: readonly string[];
  readonly withoutRowid: boolean;
  readonly registered: boolean;
  readonly exemptReason: string | null;
}

export type SchemaModel = ReadonlyMap<string, TableModel>;

interface DrizzleColumnFacts {
  shape: ColumnShape | null;
  enumValues: readonly string[] | null;
}

function drizzleColumnFacts(): Map<string, Map<string, DrizzleColumnFacts>> {
  const byTable = new Map<string, Map<string, DrizzleColumnFacts>>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    const columns = new Map<string, DrizzleColumnFacts>();
    for (const column of config.columns) {
      const type = column.columnType;
      const shape: ColumnShape | null = type === "SQLiteBoolean"
        ? "boolean"
        : type === "SQLiteTimestamp"
          ? "timestamp"
          : type === "SQLiteTextJson" || type === "SQLiteBlobJson"
            ? "json"
            : null;
      const enumValues = (column as unknown as { enumValues?: readonly string[] }).enumValues;
      columns.set(column.name, { shape, enumValues: enumValues && enumValues.length > 0 ? enumValues : null });
    }
    byTable.set(config.name, columns);
  }
  return byTable;
}

/** FTS5 virtual tables and their shadow tables are maintained by triggers, never written directly. */
function isDerivedStorage(name: string, virtualTables: ReadonlySet<string>): boolean {
  if (virtualTables.has(name)) return true;
  return [...virtualTables].some((base) => name.startsWith(`${base}_`));
}

export function loadSchemaModel(sqlite: DatabaseSync): SchemaModel {
  const drizzle = drizzleColumnFacts();
  const rows = sqlite.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string; sql: string | null }>;
  const virtualTables = new Set(rows.filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? "")).map((row) => row.name));
  const model = new Map<string, TableModel>();
  for (const row of rows) {
    if (isDerivedStorage(row.name, virtualTables) || row.name.startsWith("_dvc_") || row.name.startsWith("_cf_")) continue;
    const info = sqlite.prepare(`PRAGMA table_info("${row.name}")`).all() as Array<{
      name: string; type: string; notnull: number; pk: number;
    }>;
    const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list("${row.name}")`).all() as Array<{
      table: string; from: string; to: string | null;
    }>;
    const facts = drizzle.get(row.name);
    const spec = isCacheDepTable(row.name) ? CACHE_DEP_TABLES[row.name] : null;
    const noise = new Set<string>(spec ? spec.noise : []);
    const columns: ColumnModel[] = info.map((column) => {
      const fact = facts?.get(column.name);
      const declared = column.type.toUpperCase();
      const baseShape: ColumnShape = declared.includes("INT")
        ? "integer"
        : declared.includes("REAL") || declared.includes("FLOA") || declared.includes("DOUB") || declared.includes("NUMERIC")
          ? "real"
          : declared.includes("BLOB")
            ? "blob"
            : "text";
      const reference = foreignKeys.find((key) => key.from === column.name);
      return {
        name: column.name,
        declaredType: declared,
        shape: fact?.shape ?? baseShape,
        notNull: column.notnull === 1,
        pk: column.pk,
        enumValues: fact?.enumValues ?? null,
        references: reference ? { table: reference.table, column: reference.to ?? "id" } : null,
        noise: noise.has(column.name),
      };
    });
    model.set(row.name, {
      name: row.name,
      columns,
      pkColumns: columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
      withoutRowid: /WITHOUT\s+ROWID\s*;?\s*$/i.test(row.sql ?? ""),
      registered: isCacheDepTable(row.name),
      exemptReason: cacheDepExemptReason(row.name),
    });
  }
  return model;
}

/** Registered tables the registry names but the schema lacks (a stale registry). */
export function registryTablesMissingFromSchema(model: SchemaModel): string[] {
  return Object.keys(CACHE_DEP_TABLES).filter((table) => !model.has(table));
}

/** Registry columns (noise, `changed` lists) that no longer exist in the schema. */
export function registryColumnsMissingFromSchema(model: SchemaModel): string[] {
  const missing: string[] = [];
  for (const [table, spec] of Object.entries(CACHE_DEP_TABLES)) {
    const columns = new Set(model.get(table)?.columns.map((column) => column.name) ?? []);
    if (columns.size === 0) continue;
    const named = new Set<string>(spec.noise);
    for (const rule of spec.rules) {
      if (Array.isArray(rule.changed)) for (const column of rule.changed) named.add(column);
      const equals = rule.where?.equals;
      if (equals) for (const column of Object.keys(equals)) named.add(column);
      for (const key of rule.keys) {
        if ("columns" in key) for (const column of key.columns) named.add(column);
        if ("lookup" in key) named.add(key.lookup.column);
        if ("from" in key && "product" in key.from) named.add(key.from.product);
      }
    }
    for (const column of named) if (!columns.has(column)) missing.push(`${table}.${column}`);
  }
  return missing;
}
