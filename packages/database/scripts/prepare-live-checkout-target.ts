import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { DatabaseProvider } from "../src/provider";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
} from "./sqlite-provider-schema";
import { convertToTursoMvccArtifact } from "./prepare-turso-upload";

interface PrepareOptions {
  outputPath: string;
  provider: Extract<DatabaseProvider, "turso" | "postgres">;
}

function parseOptions(argv: readonly string[]): PrepareOptions {
  let outputPath: string | undefined;
  let provider: PrepareOptions["provider"] = "turso";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--out") outputPath = argv[++index];
    else if (argument === "--provider") {
      const value = argv[++index];
      if (value !== "turso" && value !== "postgres") {
        throw new Error("--provider must be turso or postgres.");
      }
      provider = value;
    }
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!outputPath?.trim()) throw new Error("--out is required.");
  return { outputPath: resolve(outputPath), provider };
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
  provider: PrepareOptions["provider"],
  outputPath: string,
): Promise<Record<string, string | number>> {
  await requireMissingFile(outputPath);
  const database = await createProviderSchemaDatabase(provider, outputPath);
  let applicationTables: number;
  let integrity: string;
  let foreignKeyViolations: number;
  let journalMode: string;
  try {
    journalMode = String(
      Object.values(database.prepare(
        `PRAGMA journal_mode = ${provider === "turso" ? "WAL" : "DELETE"}`,
      ).get() ?? {})[0]
        ?? "",
    ).toLowerCase();
    const expectedJournalMode = provider === "turso" ? "wal" : "delete";
    if (journalMode !== expectedJournalMode) {
      throw new Error(
        `Prepared ${provider} load-test schema could not enter ${expectedJournalMode} mode.`,
      );
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
  if (provider === "turso") {
    journalMode = (await convertToTursoMvccArtifact(outputPath)).journalMode;
  }
  return {
    outputPath,
    provider,
    applicationTables,
    journalMode,
    integrity,
    foreignKeyViolations,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const summary = await prepareLiveCheckoutTargetSchema(
    options.provider,
    options.outputPath,
  );
  process.stdout.write(`${JSON.stringify({
    ...summary,
    bytes: (await stat(options.outputPath)).size,
    sha256: await sha256File(options.outputPath),
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
