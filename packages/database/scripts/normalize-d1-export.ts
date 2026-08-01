import { spawn } from "node:child_process";
import {
  createWriteStream,
} from "node:fs";
import {
  access,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";

import {
  createProviderSchemaDatabase,
  dropTriggers,
  loadSqliteSqlFile,
  readFinalTriggerDefinitions,
  restoreTriggers,
} from "./sqlite-provider-schema";

interface Options {
  input: string;
  output: string;
  sqliteBinary: string;
}

interface TableColumn {
  name: string;
  notNull: boolean;
}

interface TablePlan {
  table: string;
  targetColumns: readonly TableColumn[];
  sourceColumns: readonly TableColumn[];
}

interface IgnoredSourceTable {
  table: string;
  rowCount: number;
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

function parseArguments(argv: readonly string[]): Options {
  let input: string | undefined;
  let output: string | undefined;
  let sqliteBinary = process.env.SQLITE3_BIN?.trim() || "sqlite3";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--input") input = argv[++index];
    else if (argument === "--out") output = argv[++index];
    else if (argument === "--sqlite-binary") sqliteBinary = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!input?.trim()) throw new Error("--input is required.");
  if (!output?.trim()) throw new Error("--out is required.");
  if (!sqliteBinary.trim()) throw new Error("--sqlite-binary must not be empty.");
  return {
    input: resolve(input),
    output: resolve(output),
    sqliteBinary,
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function assertOutputDoesNotExist(output: string): Promise<void> {
  try {
    await access(output);
  } catch {
    return;
  }
  throw new Error(`Refusing to overwrite ${output}.`);
}

async function dumpDataOnly(
  sqliteBinary: string,
  databasePath: string,
  outputPath: string,
): Promise<void> {
  const child = spawn(
    sqliteBinary,
    [databasePath, ".dump --data-only --nosys"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(
        `sqlite3 dump failed (${signal ? `signal ${signal}` : `exit ${code}`}).`,
      ));
    });
  });
  await Promise.all([
    pipeline(
      child.stdout,
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    ),
    exited,
  ]);
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

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await assertOutputDoesNotExist(options.output);
  const workingDirectory = await mkdtemp(join(tmpdir(), "scalius-d1-normalize-"));
  const sourcePath = join(workingDirectory, "source.sqlite3");
  const targetPath = join(workingDirectory, "target.sqlite3");

  try {
    await loadSqliteSqlFile(options.sqliteBinary, sourcePath, options.input);
    const target = await createProviderSchemaDatabase("turso", targetPath);
    let tableCount = 0;
    let rowCount = 0;
    const discardedColumns: string[] = [];
    let ignoredSourceTables: IgnoredSourceTable[] = [];
    let normalizedValueCount = 0;
    try {
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
        .map((table) => ({
          table,
          rowCount: Number(target.prepare(
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
            throw new Error(`Row-count mismatch while normalizing ${JSON.stringify(table)}.`);
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
    } finally {
      target.close();
    }

    await dumpDataOnly(
      options.sqliteBinary,
      targetPath,
      options.output,
    );
    process.stdout.write(`${JSON.stringify({
      input: basename(options.input),
      output: options.output,
      tableCount,
      rowCount,
      discardedColumnCount: discardedColumns.length,
      discardedColumns,
      ignoredSourceTables,
      normalizedValueCount,
      foreignKeyViolations: 0,
      integrity: "ok",
    })}\n`);
  } catch (error) {
    await rm(options.output, { force: true });
    throw error;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

await main();
