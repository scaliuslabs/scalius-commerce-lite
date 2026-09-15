/**
 * Reads the allow-listed catalog out of a source database into memory.
 *
 * Collection happens before any validation and before anything is written, so
 * the exporter can refuse a bundle on a whole-catalog rule (a dangling
 * reference, a duplicate object key) rather than discovering the problem
 * halfway through emitting SQL. Nothing outside `EXPORTED_TABLES` is read here.
 */

import { EXPORTED_TABLES } from "./tables.mjs";
import {
  primaryKeyColumns,
  readExportableRows,
  readTableColumns,
  readTableForeignKeys,
  tableExists,
} from "./source.mjs";
import { formatSchemaRevision } from "./schema-revision.mjs";

/**
 * Rule 1. The source must sit at exactly the revision the canonical migrations
 * end at, proven by the release-ledger row that migration writes about itself.
 */
export function assertSchemaRevisionMatches(sourceRevision, canonicalRevision) {
  if (
    sourceRevision.version !== canonicalRevision.version
    || sourceRevision.name !== canonicalRevision.name
    || sourceRevision.sourceSha256 !== canonicalRevision.sourceSha256
  ) {
    throw new Error(
      `The source database is at schema revision ${formatSchemaRevision(sourceRevision)} `
      + `(source_sha256 ${sourceRevision.sourceSha256}), but a portable demo-store seed can only be `
      + `exported at revision ${formatSchemaRevision(canonicalRevision)} `
      + `(source_sha256 ${canonicalRevision.sourceSha256}). Migrate the source database to the current `
      + "revision, or export from a database that is already at it.",
    );
  }
  return canonicalRevision;
}

export function collectExportTables(database) {
  const tables = new Map();
  for (const table of EXPORTED_TABLES) {
    if (!tableExists(database, table)) {
      throw new Error(
        `The source database has no ${table} table, so the catalog allow-list cannot be exported from it.`,
      );
    }
    const columns = readTableColumns(database, table);
    tables.set(table, {
      name: table,
      columns,
      primaryKey: primaryKeyColumns(table, columns),
      foreignKeys: readTableForeignKeys(database, table),
      rows: readExportableRows(database, table, columns),
    });
  }
  return tables;
}

export function rowIdentity(table, row) {
  return table.primaryKey.map((column) => String(row[column.name])).join("/");
}

export function tableRowCounts(tables) {
  return [...tables.values()].map((table) => ({ table: table.name, rows: table.rows.length }));
}
