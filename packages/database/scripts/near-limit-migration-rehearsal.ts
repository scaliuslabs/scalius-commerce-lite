import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  open,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { prepareTursoUploadBundle } from "./prepare-turso-upload";
import { createProviderSchemaDatabase } from "./sqlite-provider-schema";

const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;
const DEFAULT_PAYLOAD_BYTES = 8 * 1024;
const MAX_INSERT_ROWS = 100_000;

interface RehearsalOptions {
  outputDirectory: string;
  targetBytes: number;
  payloadBytes: number;
  sqliteBinary: string;
}

interface FixtureSummary {
  sourceDatabaseBytes: number;
  exportBytes: number;
  fixtureRows: number;
  targetBytes: number;
  payloadBytes: number;
  generationMs: number;
  exportMs: number;
}

export function parseByteSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|mib|gib)$/i.exec(value.trim());
  if (!match) throw new Error("Byte size must use B, MiB, or GiB (for example 8GiB).");
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "gib" ? GIBIBYTE : unit === "mib" ? MEBIBYTE : 1;
  const bytes = Math.round(amount * multiplier);
  if (!Number.isSafeInteger(bytes) || bytes < MEBIBYTE) {
    throw new Error("Byte size must be a safe integer of at least 1MiB.");
  }
  return bytes;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): RehearsalOptions {
  let outputDirectory: string | undefined;
  let targetBytes: number | undefined;
  let payloadBytes = DEFAULT_PAYLOAD_BYTES;
  let sqliteBinary = process.env.SQLITE3_BIN?.trim() || "sqlite3";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--out") outputDirectory = argv[++index];
    else if (argument === "--target") targetBytes = parseByteSize(argv[++index] ?? "");
    else if (argument === "--payload-bytes") {
      payloadBytes = parsePositiveInteger(argv[++index] ?? "", argument);
    } else if (argument === "--sqlite-binary") sqliteBinary = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!outputDirectory?.trim()) throw new Error("--out is required.");
  if (!targetBytes) throw new Error("--target is required.");
  if (payloadBytes > MEBIBYTE) throw new Error("--payload-bytes must not exceed 1MiB.");
  if (!sqliteBinary.trim()) throw new Error("--sqlite-binary must not be empty.");
  return {
    outputDirectory: resolve(outputDirectory),
    targetBytes,
    payloadBytes,
    sqliteBinary,
  };
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Refusing to overwrite ${path}.`);
}

function databaseBytes(database: DatabaseSync): number {
  const pageCount = Number(database.prepare("PRAGMA page_count").get()?.page_count ?? 0);
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size ?? 0);
  return pageCount * pageSize;
}

function fixtureRows(database: DatabaseSync): number {
  return Number(database.prepare(
    "SELECT COUNT(*) AS count FROM storefront_cache_queue_failures",
  ).get()?.count ?? 0);
}

async function generateSourceDatabase(
  path: string,
  targetBytes: number,
  payloadBytes: number,
): Promise<{ bytes: number; rows: number }> {
  const database = await createProviderSchemaDatabase("d1", path);
  try {
    database.exec("PRAGMA foreign_keys=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;");
    const payload = "x".repeat(payloadBytes);
    database.prepare(`
      INSERT INTO storefront_cache_queue_failures (
        id, queue_name, queue_message_id, message_type, operation_id, source,
        payload, attempts, status, last_error, replay_count, message_timestamp,
        failed_at, replayed_at, replayed_by, ignored_at, ignored_by, created_at,
        updated_at
      ) VALUES (?, 'near-limit', ?, 'fixture', NULL, 'migration-rehearsal', ?,
        0, 'ignored', NULL, 0, 0, 1, NULL, NULL, 1, 'rehearsal', 1, 1)
    `).run("near_000000000", "near_message_000000000", payload);

    let round = 0;
    while (databaseBytes(database) < targetBytes) {
      const currentBytes = databaseBytes(database);
      const currentRows = fixtureRows(database);
      const averageBytes = Math.max(payloadBytes, currentBytes / currentRows);
      const estimatedRows = Math.max(
        1,
        Math.ceil((targetBytes - currentBytes) / averageBytes),
      );
      const insertRows = Math.min(MAX_INSERT_ROWS, currentRows, estimatedRows);
      const prefix = `r${String(round).padStart(5, "0")}:`;
      database.exec("BEGIN IMMEDIATE;");
      try {
        database.prepare(`
          INSERT INTO storefront_cache_queue_failures (
            id, queue_name, queue_message_id, message_type, operation_id, source,
            payload, attempts, status, last_error, replay_count, message_timestamp,
            failed_at, replayed_at, replayed_by, ignored_at, ignored_by, created_at,
            updated_at
          )
          SELECT ? || id, queue_name, ? || queue_message_id, message_type,
                 operation_id, source, payload, attempts, status, last_error,
                 replay_count, message_timestamp, failed_at, replayed_at,
                 replayed_by, ignored_at, ignored_by, created_at, updated_at
            FROM storefront_cache_queue_failures
           ORDER BY id
           LIMIT ?
        `).run(prefix, prefix, insertRows);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      round += 1;
      if (round % 5 === 0 || databaseBytes(database) >= targetBytes) {
        process.stderr.write(
          `[near-limit] generated ${fixtureRows(database)} rows, ${databaseBytes(database)} bytes\n`,
        );
      }
    }
    const integrity = String(
      database.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
    );
    if (integrity !== "ok") throw new Error("Generated source database failed integrity_check.");
    return { bytes: databaseBytes(database), rows: fixtureRows(database) };
  } finally {
    database.close();
    await chmod(path, 0o600);
  }
}

async function dumpSqliteDatabase(
  sqliteBinary: string,
  sourcePath: string,
  exportPath: string,
): Promise<void> {
  const output = await open(exportPath, "wx", 0o600);
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(sqliteBinary, [sourcePath, ".dump"], {
        stdio: ["ignore", output.fd, "inherit"],
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolvePromise();
        else reject(new Error(
          `sqlite dump failed with ${signal ? `signal ${signal}` : `exit ${String(code)}`}.`,
        ));
      });
    });
    await output.sync();
  } finally {
    await output.close();
  }
}

export async function runNearLimitMigrationRehearsal(
  options: RehearsalOptions,
): Promise<Record<string, unknown>> {
  await assertDoesNotExist(options.outputDirectory);
  await access(dirname(options.outputDirectory));
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const sourcePath = join(options.outputDirectory, "source.sqlite3");
  const exportPath = join(options.outputDirectory, "d1-export.sql");
  const bundlePath = join(options.outputDirectory, "turso-upload-bundle");
  let succeeded = false;
  try {
    const generationStartedAt = performance.now();
    const generated = await generateSourceDatabase(
      sourcePath,
      options.targetBytes,
      options.payloadBytes,
    );
    const generationMs = performance.now() - generationStartedAt;
    const exportStartedAt = performance.now();
    await dumpSqliteDatabase(options.sqliteBinary, sourcePath, exportPath);
    const exportMs = performance.now() - exportStartedAt;
    const exportStats = await stat(exportPath);
    const fixture: FixtureSummary = {
      sourceDatabaseBytes: generated.bytes,
      exportBytes: exportStats.size,
      fixtureRows: generated.rows,
      targetBytes: options.targetBytes,
      payloadBytes: options.payloadBytes,
      generationMs: Math.round(generationMs),
      exportMs: Math.round(exportMs),
    };
    await rm(sourcePath, { force: true });

    const preparationStartedAt = performance.now();
    const prepared = await prepareTursoUploadBundle({
      input: exportPath,
      outputDirectory: bundlePath,
      sqliteBinary: options.sqliteBinary,
    });
    const preparationMs = performance.now() - preparationStartedAt;
    succeeded = true;
    return {
      version: "scalius-near-limit-rehearsal/v1",
      outputDirectory: options.outputDirectory,
      fixture,
      preparation: { ...prepared, preparationMs: Math.round(preparationMs) },
      maxNodeResidentBytes: process.resourceUsage().maxRSS * 1024,
    };
  } finally {
    if (!succeeded) await rm(options.outputDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await runNearLimitMigrationRehearsal(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[near-limit] ${message}\n`);
    process.exitCode = 1;
  });
}
