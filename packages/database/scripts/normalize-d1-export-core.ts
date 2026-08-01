import { chmod, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createSqlitePortabilityManifest,
  type SqlitePortabilityExecutor,
  type SqlitePortabilityManifest,
} from "../src/portability";
import {
  createProviderSchemaDatabase,
  dropTriggers,
  loadSqliteSqlFile,
  readFinalTriggerDefinitions,
  restoreTriggers,
} from "./sqlite-provider-schema";

interface TableColumn {
  name: string;
  notNull: boolean;
}

interface TablePlan {
  table: string;
  targetColumns: readonly TableColumn[];
  sourceColumns: readonly TableColumn[];
}

export interface IgnoredSourceTable {
  table: string;
  rowCount: number;
}

export interface TursoUploadPragmas {
  pageSize: 4096;
  journalMode: "wal" | "mvcc";
  autoVacuum: 0;
  encoding: "UTF-8";
}

export interface D1NormalizationReceipt {
  sourceFilename: string;
  sourceBytes: number;
  sourceSha256: string;
  tableCount: number;
  rowCount: number;
  discardedColumns: readonly string[];
  ignoredSourceTables: readonly IgnoredSourceTable[];
  normalizedValueCount: number;
  foreignKeyViolations: 0;
  integrity: "ok";
  portabilityManifest: SqlitePortabilityManifest;
  uploadPragmas: TursoUploadPragmas;
}

export interface NormalizeD1ExportOptions {
  input: string;
  targetDatabasePath: string;
  sqliteBinary: string;
}

/**
 * The production D1 predates the current baseline constraint on this column.
 * `created_at` is immutable, non-null, and preserves the original row time, so
 * it is a deterministic replacement for the legacy null update timestamp.
 */
function legacyProjection(table: string, column: string): string | undefined {
  if (table === "permissions" && column === "updated_at") {
    return 'COALESCE("updated_at", "created_at")';
  }
  return undefined;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isProviderDerivedSourceTable(table: string): boolean {
  return (
    /_fts(?:_|$)/i.test(table) ||
    /^(?:_cf_|__turso_|libsql_|sqlite_)/i.test(table) ||
    table === "d1_migrations"
  );
}

function readColumns(
  database: DatabaseSync,
  schema: "main" | "source",
  table: string,
): readonly TableColumn[] {
  return database.prepare(
    `PRAGMA ${schema}.table_info(${quoteIdentifier(table)})`,
  ).all().map((row) => ({
    name: String(row.name),
    notNull: Number(row.notnull) === 1,
  }));
}

function createNodeSqliteExecutor(database: DatabaseSync): SqlitePortabilityExecutor {
  return {
    async query(sql, params = []) {
      const normalizedParams = params.map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      );
      return database.prepare(sql).all(
        ...normalizedParams,
      ) as Record<string, unknown>[];
    },
  };
}

async function removeSqliteFiles(databasePath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
  ]);
}

export async function normalizeD1ExportToTursoDatabase(
  options: NormalizeD1ExportOptions,
): Promise<D1NormalizationReceipt> {
  const sourcePath = join(dirname(options.targetDatabasePath), "source.sqlite3");
  let target: DatabaseSync | undefined;
  let succeeded = false;

  try {
    const sourceLoad = await loadSqliteSqlFile(
      options.sqliteBinary,
      sourcePath,
      options.input,
    );
    target = await createProviderSchemaDatabase(
      "turso",
      options.targetDatabasePath,
    );
    let tableCount = 0;
    let rowCount = 0;
    const discardedColumns: string[] = [];
    let ignoredSourceTables: IgnoredSourceTable[] = [];
    let normalizedValueCount = 0;

    const triggers = readFinalTriggerDefinitions(target);
    target.exec("PRAGMA foreign_keys=OFF;");
    dropTriggers(target, triggers);
    target.prepare("ATTACH DATABASE ? AS source").run(sourcePath);

    const tables = target.prepare(`
      SELECT name
      FROM main.sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name));
    const targetTableNames = new Set(tables);
    ignoredSourceTables = target.prepare(`
      SELECT name
      FROM source.sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()
      .map((row) => String(row.name))
      .filter((table) => !targetTableNames.has(table))
      .filter((table) => !isProviderDerivedSourceTable(table))
      .map((table) => ({
        table,
        rowCount: Number(target!.prepare(
          `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)}`,
        ).get()?.count ?? 0),
      }));

    const tablePlans: TablePlan[] = [];
    const nullabilityIssues: string[] = [];
    for (const table of tables) {
      const targetColumns = readColumns(target, "main", table);
      const sourceColumns = readColumns(target, "source", table);
      if (sourceColumns.length === 0) {
        throw new Error(`Source export is missing table ${JSON.stringify(table)}.`);
      }
      const sourceColumnsByName = new Map(
        sourceColumns.map((column) => [column.name, column]),
      );
      const missingColumns = targetColumns
        .map((column) => column.name)
        .filter((column) => !sourceColumnsByName.has(column));
      if (missingColumns.length > 0) {
        throw new Error(
          `Source table ${JSON.stringify(table)} is missing current columns: ${missingColumns.join(", ")}.`,
        );
      }
      for (const column of targetColumns) {
        if (!column.notNull || sourceColumnsByName.get(column.name)?.notNull) {
          continue;
        }
        const nullRows = Number(target.prepare(
          `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)} `
          + `WHERE ${quoteIdentifier(column.name)} IS NULL`,
        ).get()?.count ?? 0);
        if (nullRows > 0) {
          if (legacyProjection(table, column.name)) {
            normalizedValueCount += nullRows;
          } else {
            nullabilityIssues.push(`${table}.${column.name} (${nullRows} rows)`);
          }
        }
      }
      tablePlans.push({ table, targetColumns, sourceColumns });
    }
    if (nullabilityIssues.length > 0) {
      throw new Error(
        `Source rows violate current NOT NULL constraints: ${nullabilityIssues.join(", ")}.`,
      );
    }

    target.exec("BEGIN;");
    try {
      for (const { table, targetColumns, sourceColumns } of tablePlans) {
        const targetColumnNames = new Set(
          targetColumns.map((column) => column.name),
        );
        discardedColumns.push(...sourceColumns
          .filter((column) => !targetColumnNames.has(column.name))
          .map((column) => `${table}.${column.name}`));

        const columnList = targetColumns
          .map((column) => quoteIdentifier(column.name))
          .join(", ");
        const projectionList = targetColumns
          .map((column) =>
            legacyProjection(table, column.name)
            ?? quoteIdentifier(column.name),
          )
          .join(", ");
        target.exec(`DELETE FROM main.${quoteIdentifier(table)};`);
        target.prepare(
          `INSERT INTO main.${quoteIdentifier(table)} (${columnList}) `
          + `SELECT ${projectionList} FROM source.${quoteIdentifier(table)}`,
        ).run();
        const sourceRows = Number(target.prepare(
          `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)}`,
        ).get()?.count ?? 0);
        const targetRows = Number(target.prepare(
          `SELECT COUNT(*) AS count FROM main.${quoteIdentifier(table)}`,
        ).get()?.count ?? 0);
        if (sourceRows !== targetRows) {
          throw new Error(
            `Row-count mismatch while normalizing ${JSON.stringify(table)}.`,
          );
        }
        tableCount += 1;
        rowCount += targetRows;
      }
      restoreTriggers(target, triggers);
      target.exec("COMMIT;");
    } catch (error) {
      target.exec("ROLLBACK;");
      throw error;
    }

    target.exec("PRAGMA foreign_keys=ON;");
    const foreignKeyViolations = target
      .prepare("PRAGMA main.foreign_key_check")
      .all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Normalized database has ${foreignKeyViolations.length} foreign-key violations.`,
      );
    }
    const integrity = String(
      target.prepare("PRAGMA main.integrity_check").get()?.integrity_check ?? "",
    );
    if (integrity !== "ok") {
      throw new Error("Normalized database failed SQLite integrity_check.");
    }
    target.exec("DETACH DATABASE source;");

    const portabilityManifest = await createSqlitePortabilityManifest(
      createNodeSqliteExecutor(target),
      { chunkSize: 1_000 },
    );
    const pageSize = Number(
      target.prepare("PRAGMA page_size").get()?.page_size ?? 0,
    );
    const autoVacuum = Number(
      target.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum ?? -1,
    );
    const encoding = String(
      target.prepare("PRAGMA encoding").get()?.encoding ?? "",
    );
    if (pageSize !== 4096 || autoVacuum !== 0 || encoding !== "UTF-8") {
      throw new Error(
        `Turso upload file requirements are not satisfied: page_size=${pageSize}, auto_vacuum=${autoVacuum}, encoding=${encoding}.`,
      );
    }
    // Close the manifest connection before switching journal mode. Node's
    // prepared-statement finalizers otherwise keep transient read locks alive.
    target.close();
    target = undefined;
    const uploadDatabase = new DatabaseSync(options.targetDatabasePath);
    try {
      const journalMode = String(
        uploadDatabase.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode ?? "",
      ).toLowerCase();
      if (journalMode !== "wal") {
        throw new Error(
          `Failed to enable WAL journal mode; received ${journalMode || "empty"}.`,
        );
      }
      const checkpoint = uploadDatabase
        .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
        .get();
      if (Number(checkpoint?.busy ?? 1) !== 0) {
        throw new Error(
          "SQLite WAL checkpoint remained busy while preparing upload file.",
        );
      }
    } finally {
      uploadDatabase.close();
    }
    await chmod(options.targetDatabasePath, 0o600);

    const receipt: D1NormalizationReceipt = {
      sourceFilename: basename(options.input),
      sourceBytes: sourceLoad.bytes,
      sourceSha256: sourceLoad.sha256,
      tableCount,
      rowCount,
      discardedColumns,
      ignoredSourceTables,
      normalizedValueCount,
      foreignKeyViolations: 0,
      integrity: "ok",
      portabilityManifest,
      uploadPragmas: {
        pageSize: 4096,
        journalMode: "wal",
        autoVacuum: 0,
        encoding: "UTF-8",
      },
    };
    succeeded = true;
    return receipt;
  } finally {
    target?.close();
    await removeSqliteFiles(sourcePath);
    if (!succeeded) {
      await removeSqliteFiles(options.targetDatabasePath);
    }
  }
}
