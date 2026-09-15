/**
 * Read-only access to the database a seed bundle is taken from.
 *
 * Export mode has exactly one input: a SQLite file. It opens that file with
 * `readOnly: true`, so the export is write-free against the source by
 * construction rather than by discipline — SQLite itself rejects any statement
 * that would modify it. Nothing in this module opens a socket, reads an
 * environment variable, or touches credential material.
 *
 * Table shape is always discovered through `PRAGMA table_info` and
 * `PRAGMA foreign_key_list` rather than hard-coded. A hard-coded column list or
 * edge list would silently rot the first time a migration adds a column or a
 * reference, and a seed that quietly dropped a column would still look valid.
 */

import { DatabaseSync } from "node:sqlite";

import { EXPORT_ROW_FILTERS, SCHEMA_LEDGER_TABLE } from "./tables.mjs";

/** SQLite's default parameter ceiling is far higher; 500 keeps statements readable. */
const IN_CLAUSE_CHUNK = 500;

export function openSourceDatabase(sourceDatabasePath) {
  return new DatabaseSync(sourceDatabasePath, { readOnly: true });
}

export function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`Refusing to build SQL for the unexpected identifier ${JSON.stringify(name)}.`);
  }
  return `"${name}"`;
}

export function tableExists(database, table) {
  const row = database
    .prepare("SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Number(row?.present ?? 0) > 0;
}

/**
 * Columns in declaration order, carrying the declared affinity the SQL writer
 * needs and the primary-key ordinal the deterministic row order needs.
 */
export function readTableColumns(database, table) {
  const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  if (columns.length === 0) {
    throw new Error(`Table ${table} does not exist in the source database, so its rows cannot be exported.`);
  }
  return columns.map((column) => ({
    name: String(column.name),
    declaredType: String(column.type ?? "").toUpperCase(),
    notNull: Number(column.notnull) === 1,
    primaryKeyPosition: Number(column.pk),
  }));
}

/**
 * Foreign keys grouped by constraint id, so a composite reference stays one
 * edge with several column pairs instead of several half-edges.
 */
export function readTableForeignKeys(database, table) {
  const rows = database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all();
  const byConstraint = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    const existing = byConstraint.get(id) ?? { id, table: String(row.table), columns: [] };
    existing.columns.push({ from: String(row.from), to: row.to === null ? null : String(row.to) });
    byConstraint.set(id, existing);
  }
  return [...byConstraint.values()]
    .sort((left, right) => left.id - right.id)
    .map((edge) => ({
      table: edge.table,
      columns: edge.columns.sort((left, right) => left.from.localeCompare(right.from)),
    }));
}

/** The primary-key columns, in key order; every exported table declares one. */
export function primaryKeyColumns(table, columns) {
  const keyColumns = columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
  if (keyColumns.length === 0) {
    throw new Error(
      `Table ${table} declares no primary key, so the exporter cannot order its rows deterministically.`,
    );
  }
  return keyColumns;
}

/**
 * Builds the row filter for one table: soft-deleted rows are never exported,
 * and `media` additionally exports only assets that are `ready`.
 */
export function rowFilterFor(table, columns) {
  const clauses = [];
  if (columns.some((column) => column.name === "deleted_at")) clauses.push('"deleted_at" IS NULL');
  const extra = EXPORT_ROW_FILTERS[table];
  if (extra) clauses.push(extra);
  return clauses;
}

export function readExportableRows(database, table, columns) {
  const projection = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const clauses = rowFilterFor(table, columns);
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const order = primaryKeyColumns(table, columns)
    .map((column) => quoteIdentifier(column.name))
    .join(", ");
  return database
    .prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}${where} ORDER BY ${order}`)
    .all();
}

/**
 * Runs a bounded `IN (...)` probe in chunks, so a source with a large orders
 * table never builds a statement with tens of thousands of parameters.
 */
export function selectRowsMatchingAny(database, { table, identitySql, columns, values }) {
  if (columns.length === 0 || values.length === 0) return [];
  const matched = [];
  for (let offset = 0; offset < values.length; offset += IN_CLAUSE_CHUNK) {
    const chunk = values.slice(offset, offset + IN_CLAUSE_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const predicate = columns
      .map((column) => `${quoteIdentifier(column)} IN (${placeholders})`)
      .join(" OR ");
    const projection = columns.map((column) => quoteIdentifier(column)).join(", ");
    const rows = database
      .prepare(`SELECT ${identitySql} AS identity, ${projection} FROM ${quoteIdentifier(table)} WHERE ${predicate}`)
      .all(...Array.from({ length: columns.length }, () => chunk).flat());
    matched.push(...rows);
  }
  return matched;
}

/**
 * The source's own claim about which revision it sits at: the highest row of
 * the provider-neutral release ledger.
 */
export function readSourceSchemaRevision(database) {
  if (!tableExists(database, SCHEMA_LEDGER_TABLE)) {
    throw new Error(
      `The source database has no ${SCHEMA_LEDGER_TABLE} table, so its schema revision cannot be proven. A portable demo-store seed is only exportable from a database migrated by this repository.`,
    );
  }
  const row = database
    .prepare(
      `SELECT "version", "name", "source_sha256" AS "sourceSha256" FROM ${quoteIdentifier(SCHEMA_LEDGER_TABLE)} ORDER BY "version" DESC LIMIT 1`,
    )
    .get();
  if (!row) {
    throw new Error(
      `The source database's ${SCHEMA_LEDGER_TABLE} table is empty, so its schema revision cannot be proven.`,
    );
  }
  return {
    version: Number(row.version),
    name: String(row.name),
    sourceSha256: String(row.sourceSha256),
  };
}
