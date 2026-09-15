/**
 * Canonical SQL for a portable catalog.
 *
 * `seed.sql` has to be two things at once: byte-identical across two exports of
 * the same database, and loadable into a freshly migrated database at the same
 * schema revision. Determinism comes from fixed table order, primary-key row
 * order, an explicit column list per row and value encodings with exactly one
 * spelling per value. Loadability comes from the dependency order of
 * `EXPORTED_TABLES` plus `PRAGMA defer_foreign_keys = ON`, which lets the
 * self-referencing `media.poster_media_id` edge resolve within the transaction.
 *
 * The FTS shadow tables are deliberately absent. `products_fts`,
 * `product_variants_fts` and `categories_fts` are maintained by AFTER INSERT
 * triggers that already exist in the migrated schema, so they repopulate
 * themselves as the seed loads. Emitting their contents would both duplicate
 * that work and couple the bundle to fts5 internals.
 */

import { EXPORTED_TABLES, SEED_SQL_FILENAME } from "./tables.mjs";
import { formatSchemaRevision } from "./schema-revision.mjs";

const REAL_AFFINITY = /REAL|FLOA|DOUB/u;
const NUL_CHARACTER = String.fromCharCode(0);

function describeValue(value) {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "a BLOB";
  return `a ${typeof value} value`;
}

/**
 * One spelling per value, and an error for anything a portable seed cannot
 * carry. BLOBs are rejected rather than hex-encoded: no allow-listed column
 * declares one, so meeting a BLOB means the source is not the schema this
 * exporter was written against.
 */
export function encodeSqlValue(value, { table, column }) {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    if (value.includes(NUL_CHARACTER)) {
      throw new Error(
        `${table}.${column.name} holds a string containing a NUL byte, which cannot be written as a SQL literal.`,
      );
    }
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `${table}.${column.name} holds the non-finite value ${String(value)}, which cannot be written as a SQL literal.`,
      );
    }
    if (Number.isInteger(value)) {
      return REAL_AFFINITY.test(column.declaredType) ? `${value}.0` : String(value);
    }
    return String(value);
  }
  throw new Error(
    `${table}.${column.name} holds ${describeValue(value)}, which a portable demo-store seed cannot carry. `
    + "Export is limited to the text, integer and real values the catalog schema declares.",
  );
}

export function buildInsertStatement(table, row) {
  const columns = table.columns.map((column) => `"${column.name}"`).join(", ");
  const values = table.columns
    .map((column) => encodeSqlValue(row[column.name], { table: table.name, column }))
    .join(", ");
  return `INSERT INTO "${table.name}" (${columns}) VALUES (${values});`;
}

function buildHeader({ revision, counts, totalRows }) {
  return [
    `-- ${SEED_SQL_FILENAME}: portable demo-store catalog seed.`,
    "-- Contract: scalius-demo-store-seed/v1",
    `-- Schema revision: ${formatSchemaRevision(revision)}`,
    `-- Migration source_sha256: ${revision.sourceSha256}`,
    `-- Rows: ${totalRows} across ${counts.length} catalog tables`,
    ...counts.map(({ table, rows }) => `--   ${table}: ${rows}`),
    "--",
    "-- This file carries catalog and presentation rows only. It contains no credentials,",
    "-- no orders, no customers, no admin users, no sessions, no settings and no payment",
    "-- or session material of any kind.",
    "--",
    "-- Load it into a freshly migrated, empty catalog at exactly the schema revision above,",
    "-- with PRAGMA foreign_keys = ON. The single transaction makes the load all-or-nothing:",
    "-- loading it over a catalog that already holds these rows aborts and rolls back rather",
    "-- than merging. The products, product_variants and categories FTS indexes are rebuilt",
    "-- by the schema's own AFTER INSERT triggers as this file loads.",
  ].join("\n");
}

export function buildSeedSql({ revision, tables }) {
  const counts = EXPORTED_TABLES.map((name) => ({ table: name, rows: tables.get(name).rows.length }));
  const totalRows = counts.reduce((total, entry) => total + entry.rows, 0);
  const statements = [];
  for (const name of EXPORTED_TABLES) {
    const table = tables.get(name);
    if (table.rows.length === 0) continue;
    statements.push(`-- ${name} (${table.rows.length} row${table.rows.length === 1 ? "" : "s"})`);
    for (const row of table.rows) statements.push(buildInsertStatement(table, row));
  }
  return [
    buildHeader({ revision, counts, totalRows }),
    "",
    "BEGIN;",
    "PRAGMA defer_foreign_keys = ON;",
    "",
    ...statements,
    "",
    "COMMIT;",
    "",
  ].join("\n");
}
