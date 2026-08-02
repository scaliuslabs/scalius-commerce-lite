import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
} from "./sqlite-provider-schema";
import { convertToTursoMvccArtifact } from "./prepare-turso-upload";

function parseOutputPath(argv: readonly string[]): string {
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--out") outputPath = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!outputPath?.trim()) throw new Error("--out is required.");
  return resolve(outputPath);
}

async function requireMissingFile(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error("Load-test schema output already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareLiveCheckoutTargetSchema(
  outputPath: string,
): Promise<Record<string, string | number>> {
  await requireMissingFile(outputPath);
  const database = await createProviderSchemaDatabase("turso", outputPath);
  let applicationTables = 0;
  let integrity = "";
  let foreignKeyViolations = 0;
  try {
    const journalMode = String(
      Object.values(database.prepare("PRAGMA journal_mode = WAL").get() ?? {})[0]
        ?? "",
    ).toLowerCase();
    if (journalMode !== "wal") {
      throw new Error("Prepared load-test schema could not enter WAL mode.");
    }
    integrity = String(
      Object.values(database.prepare("PRAGMA integrity_check").get() ?? {})[0]
        ?? "",
    ).toLowerCase();
    foreignKeyViolations = database
      .prepare("PRAGMA foreign_key_check")
      .all().length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) {
      throw new Error("Prepared load-test schema failed SQLite integrity checks.");
    }
    applicationTables = readApplicationTableNames(database).length;
    if (applicationTables < 100) {
      throw new Error("Prepared load-test schema is missing application tables.");
    }
  } finally {
    database.close();
    await chmod(outputPath, 0o600);
  }
  const pragmas = await convertToTursoMvccArtifact(outputPath);
  return {
    outputPath,
    applicationTables,
    journalMode: pragmas.journalMode,
    integrity,
    foreignKeyViolations,
  };
}

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const summary = await prepareLiveCheckoutTargetSchema(outputPath);
  process.stdout.write(`${JSON.stringify({
    ...summary,
    bytes: (await stat(outputPath)).size,
    sha256: await sha256File(outputPath),
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
