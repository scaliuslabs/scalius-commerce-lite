import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import type { DatabaseProvider } from "../src/provider";

const MANIFEST_VERSION = "scalius-provider-migrations/v1" as const;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(scriptDirectory, "../migrations");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv: readonly string[]): {
  provider: DatabaseProvider;
  outputDirectory: string;
} {
  let provider: string | undefined;
  let outputDirectory: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--provider") provider = argv[++index];
    else if (argument === "--out") outputDirectory = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }

  if (provider !== "d1" && provider !== "turso") {
    throw new Error("--provider must be d1 or turso.");
  }
  if (!outputDirectory?.trim()) throw new Error("--out is required.");

  return {
    provider,
    outputDirectory: resolve(outputDirectory),
  };
}

async function requireEmptyOutputDirectory(outputDirectory: string): Promise<void> {
  try {
    const existing = await stat(outputDirectory);
    if (!existing.isDirectory()) {
      throw new Error("Migration output path already exists and is not a directory.");
    }
    const entries = await readdir(outputDirectory);
    if (entries.length > 0) {
      throw new Error("Migration output directory must be empty.");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    await mkdir(outputDirectory, { recursive: true });
  }
}

async function main(): Promise<void> {
  const { provider, outputDirectory } = parseArguments(process.argv.slice(2));
  await requireEmptyOutputDirectory(outputDirectory);

  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) throw new Error("No canonical database migrations were found.");

  const manifestFiles: Array<{
    name: string;
    sourceSha256: string;
    compiledSha256: string;
  }> = [];
  const bundleParts: string[] = [];

  for (const name of names) {
    const source = await readFile(join(migrationDirectory, name), "utf8");
    const compiled = compileSqliteMigrationForProvider(source, provider);
    await writeFile(join(outputDirectory, name), compiled, { encoding: "utf8", flag: "wx" });
    const file = {
      name,
      sourceSha256: sha256(source),
      compiledSha256: sha256(compiled),
    };
    manifestFiles.push(file);
    bundleParts.push(`${name}\0${compiled.length}\0${compiled}`);
  }

  const manifest = {
    version: MANIFEST_VERSION,
    provider,
    migrationCount: manifestFiles.length,
    bundleSha256: sha256(bundleParts.join("\0")),
    files: manifestFiles,
  };
  await writeFile(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  process.stdout.write(`${JSON.stringify({
    provider,
    migrationCount: names.length,
    bundleSha256: manifest.bundleSha256,
    outputDirectory,
  })}\n`);
}

await main();
