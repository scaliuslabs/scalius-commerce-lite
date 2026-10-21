import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import type { SqliteTriggerDefinition } from "../src/migration-artifacts";
import type { DatabaseProvider } from "../src/provider";
import { compiledMigrationSql, migratedImage, restoreMigratedImage } from "../src/testing/migrated-image";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const canonicalMigrationDirectory = resolve(
  scriptDirectory,
  "../migrations",
);

export interface SqliteSqlLoadReceipt {
  bytes: number;
  sha256: string;
}

export async function loadSqliteSqlFile(
  sqliteBinary: string,
  databasePath: string,
  inputPath: string,
): Promise<SqliteSqlLoadReceipt> {
  const child = spawn(sqliteBinary, ["-bail", databasePath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const hash = createHash("sha256");
  let bytes = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Keep diagnostics bounded. We report only the SQLite error class and
    // source line below so SQL values from a merchant export never enter logs.
    if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
  });
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveExit();
      else {
        const diagnostic = stderr.match(
          /\b(parse|runtime) error near line (\d+)\b/i,
        );
        rejectExit(new Error(
          `sqlite3 import failed (${signal ? `signal ${signal}` : `exit ${code}`}`
          + (diagnostic
            ? `; ${diagnostic[1]!.toLowerCase()} error near line ${diagnostic[2]}`
            : "")
          + ").",
        ));
      }
    });
  });
  const [streamResult, exitResult] = await Promise.allSettled([
    pipeline(createReadStream(inputPath), meter, child.stdin),
    exited,
  ]);
  // sqlite3 commonly closes stdin as soon as it encounters a bad statement.
  // Prefer its stable exit diagnostic over the resulting, unhelpful EPIPE.
  if (exitResult.status === "rejected") throw exitResult.reason;
  if (streamResult.status === "rejected") throw streamResult.reason;
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * A database holding the schema the provider's migrations build (before
 * `beforeMigration`, for sidecar parity tests), at `location`: memory, or a
 * new file. The chain is replayed once per digest of its compiled script and
 * cached as an image (`src/testing/migrated-image.ts`, shared with the test
 * harness); each call restores a copy of it.
 */
export async function createProviderSchemaDatabase(
  provider: DatabaseProvider,
  location = ":memory:",
  beforeMigration?: string,
): Promise<DatabaseSync> {
  const image = migratedImage(provider, beforeMigration);
  if (image && location !== ":memory:") {
    // "wx": the file must be new, as replaying the chain onto it required.
    await writeFile(location, image, { flag: "wx" });
    return new DatabaseSync(location);
  }
  const database = new DatabaseSync(location);
  try {
    if (image) restoreMigratedImage(database, image);
    else database.exec(compiledMigrationSql(provider, beforeMigration));
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function sqliteLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Statements that recreate `database` (its schema and rows) on an empty
 * SQLite-dialect target: tables, their rows, indexes, then triggers, so the
 * copied rows fire none. A fresh store gets the schema the migration chain
 * ends in, with the chain's seed rows and ledger, without replaying its table
 * rebuilds and backfills.
 */
export function sqliteSchemaStatements(database: DatabaseSync): string[] {
  const objects = database.prepare(`
    SELECT type, name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY rowid
  `).all() as Array<{ type: string; name: string; sql: string }>;
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const tables = objects.filter((object) => object.type === "table");
  const rows = tables.flatMap(({ name }) =>
    (database.prepare(`SELECT * FROM ${quote(name)}`).all() as Array<Record<string, unknown>>).map((row) => {
      const columns = Object.keys(row);
      return `INSERT INTO ${quote(name)} (${columns.map(quote).join(", ")}) VALUES (${columns.map((column) => sqliteLiteral(row[column])).join(", ")})`;
    }));
  return [
    ...tables.map((object) => object.sql),
    ...rows,
    ...objects.filter((object) => object.type === "index" || object.type === "view").map((object) => object.sql),
    ...objects.filter((object) => object.type === "trigger").map((object) => object.sql),
  ];
}

export function readFinalTriggerDefinitions(
  database: DatabaseSync,
): readonly SqliteTriggerDefinition[] {
  return database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
      AND sql IS NOT NULL
    ORDER BY name
  `).all().map((row) => ({
    name: String(row.name),
    sql: String(row.sql),
  }));
}

export function readApplicationTableNames(
  database: DatabaseSync,
): readonly string[] {
  return database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT GLOB '*_fts*'
      AND name NOT IN ('_cf_KV', 'd1_migrations')
      AND name NOT LIKE '__turso_%'
      AND name NOT LIKE 'libsql_%'
    ORDER BY name
  `).all().map((row) => String(row.name));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function dropTriggers(
  database: DatabaseSync,
  triggers: readonly SqliteTriggerDefinition[],
): void {
  for (const trigger of triggers) {
    database.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`);
  }
}

export function restoreTriggers(
  database: DatabaseSync,
  triggers: readonly SqliteTriggerDefinition[],
): void {
  for (const trigger of triggers) {
    database.exec(`${trigger.sql.trim().replace(/;\s*$/, "")};`);
  }
}
