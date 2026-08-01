import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  compileSqliteMigrationForProvider,
  type SqliteTriggerDefinition,
} from "../src/migration-artifacts";
import type { DatabaseProvider } from "../src/provider";

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
    stdio: ["pipe", "ignore", "ignore"],
  });
  const hash = createHash("sha256");
  let bytes = 0;
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
      else rejectExit(new Error(
        `sqlite3 import failed (${signal ? `signal ${signal}` : `exit ${code}`}).`,
      ));
    });
  });
  await Promise.all([
    pipeline(createReadStream(inputPath), meter, child.stdin),
    exited,
  ]);
  return { bytes, sha256: hash.digest("hex") };
}

export async function createProviderSchemaDatabase(
  provider: DatabaseProvider,
  location = ":memory:",
): Promise<DatabaseSync> {
  const database = new DatabaseSync(location);
  const migrationNames = (await readdir(canonicalMigrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));

  try {
    for (const name of migrationNames) {
      const canonical = await readFile(
        join(canonicalMigrationDirectory, name),
        "utf8",
      );
      database.exec(compileSqliteMigrationForProvider(canonical, provider));
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
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
