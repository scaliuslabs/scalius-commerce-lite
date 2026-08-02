import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { normalizeD1ExportToTursoDatabase } from "./normalize-d1-export-core";

interface Options {
  input: string;
  output: string;
  sqliteBinary: string;
  retiredSchemaArchive?: string;
}

function parseArguments(argv: readonly string[]): Options {
  let input: string | undefined;
  let output: string | undefined;
  let retiredSchemaArchive: string | undefined;
  let sqliteBinary = process.env.SQLITE3_BIN?.trim() || "sqlite3";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--input") input = argv[++index];
    else if (argument === "--out") output = argv[++index];
    else if (argument === "--retired-schema-archive") retiredSchemaArchive = argv[++index];
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
    retiredSchemaArchive: retiredSchemaArchive
      ? resolve(retiredSchemaArchive)
      : undefined,
  };
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

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await assertOutputDoesNotExist(options.output);
  if (options.retiredSchemaArchive) {
    await assertOutputDoesNotExist(options.retiredSchemaArchive);
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), "scalius-d1-normalize-"));
  const targetPath = join(workingDirectory, "target.sqlite3");

  try {
    const receipt = await normalizeD1ExportToTursoDatabase({
      input: options.input,
      targetDatabasePath: targetPath,
      sqliteBinary: options.sqliteBinary,
      retiredSchemaArchivePath: options.retiredSchemaArchive,
    });
    await dumpDataOnly(options.sqliteBinary, targetPath, options.output);
    process.stdout.write(`${JSON.stringify({
      input: receipt.sourceFilename,
      inputBytes: receipt.sourceBytes,
      inputSha256: receipt.sourceSha256,
      output: options.output,
      tableCount: receipt.tableCount,
      rowCount: receipt.rowCount,
      discardedColumnCount: receipt.discardedColumns.length,
      discardedColumns: receipt.discardedColumns,
      ignoredSourceTables: receipt.ignoredSourceTables,
      retiredSchemaArchive: receipt.retiredSchemaArchive,
      normalizedValueCount: receipt.normalizedValueCount,
      sourceFingerprint: receipt.portabilityManifest.fingerprint,
      foreignKeyViolations: receipt.foreignKeyViolations,
      integrity: receipt.integrity,
    })}\n`);
  } catch (error) {
    await rm(options.output, { force: true });
    if (options.retiredSchemaArchive) {
      await rm(options.retiredSchemaArchive, { force: true });
    }
    throw error;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

await main();
