import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
} from "./sqlite-provider-schema";
import { sha256File } from "./turso-upload-bundle";

export const D1_PORTABLE_EXPORT_VERSION =
  "scalius-d1-portable-export/v1" as const;
export const D1_PORTABLE_EXPORT_FILENAME = "source.sql";
export const D1_PORTABLE_EXPORT_EVIDENCE_FILENAME = "export-evidence.json";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWranglerEntry = resolve(
  scriptDirectory,
  "../../../apps/api/node_modules/wrangler/bin/wrangler.js",
);
const defaultWranglerConfig = resolve(
  scriptDirectory,
  "../../../apps/api/wrangler.jsonc",
);

export interface ExportD1PortableOptions {
  database: string;
  outputDirectory: string;
  expectedBookmark: string;
  wranglerEntry?: string;
  wranglerConfig?: string;
}

export interface D1PortableExportEvidence {
  version: typeof D1_PORTABLE_EXPORT_VERSION;
  database: string;
  bookmark: string;
  tables: readonly string[];
  tableSetSha256: string;
  artifact: {
    filename: typeof D1_PORTABLE_EXPORT_FILENAME;
    bytes: number;
    sha256: string;
  };
}

export interface ExportD1PortableSummary {
  bundle: string;
  database: string;
  bookmark: string;
  tableCount: number;
  tableSetSha256: string;
  artifactBytes: number;
  artifactSha256: string;
}

function requireOpaque(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} must be a non-empty opaque value.`);
  }
  return normalized;
}

function parseArguments(argv: readonly string[]): ExportD1PortableOptions {
  let database: string | undefined;
  let outputDirectory: string | undefined;
  let expectedBookmark: string | undefined;
  let wranglerEntry: string | undefined;
  let wranglerConfig: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--database") database = argv[++index];
    else if (argument === "--out") outputDirectory = argv[++index];
    else if (argument === "--expected-bookmark") expectedBookmark = argv[++index];
    else if (argument === "--wrangler-entry") wranglerEntry = argv[++index];
    else if (argument === "--config") wranglerConfig = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!database?.trim()) throw new Error("--database is required.");
  if (!outputDirectory?.trim()) throw new Error("--out is required.");
  if (!expectedBookmark?.trim()) {
    throw new Error("--expected-bookmark is required.");
  }
  return {
    database,
    outputDirectory: resolve(outputDirectory),
    expectedBookmark,
    wranglerEntry: wranglerEntry ? resolve(wranglerEntry) : undefined,
    wranglerConfig: wranglerConfig ? resolve(wranglerConfig) : undefined,
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

async function runWrangler(
  wranglerEntry: string,
  args: readonly string[],
): Promise<string> {
  const child = spawn(process.execPath, [wranglerEntry, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveExit();
      } else {
        rejectExit(new Error(
          `Wrangler failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${stderr.trim() || stdout.trim()}`,
        ));
      }
    });
  });
  return stdout;
}

async function readD1Bookmark(input: {
  wranglerEntry: string;
  wranglerConfig: string;
  database: string;
}): Promise<string> {
  const stdout = await runWrangler(input.wranglerEntry, [
    "d1",
    "time-travel",
    "info",
    input.database,
    "--json",
    "--config",
    input.wranglerConfig,
  ]);
  const parsed = JSON.parse(stdout) as { bookmark?: unknown };
  if (typeof parsed.bookmark !== "string") {
    throw new Error("Wrangler did not return a D1 bookmark.");
  }
  return requireOpaque(parsed.bookmark, "D1 bookmark");
}

async function readPortableTableNames(): Promise<readonly string[]> {
  const database = await createProviderSchemaDatabase("d1");
  try {
    return readApplicationTableNames(database);
  } finally {
    database.close();
  }
}

export async function exportD1PortableBundle(
  options: ExportD1PortableOptions,
): Promise<ExportD1PortableSummary> {
  const database = requireOpaque(options.database, "database");
  await assertDoesNotExist(options.outputDirectory);
  const outputParent = dirname(options.outputDirectory);
  await access(outputParent);
  const wranglerEntry = resolve(options.wranglerEntry ?? defaultWranglerEntry);
  const wranglerConfig = resolve(options.wranglerConfig ?? defaultWranglerConfig);
  await Promise.all([access(wranglerEntry), access(wranglerConfig)]);
  const temporaryBundle = await mkdtemp(
    join(outputParent, ".scalius-d1-export-"),
  );
  const exportPath = join(temporaryBundle, D1_PORTABLE_EXPORT_FILENAME);
  const evidencePath = join(
    temporaryBundle,
    D1_PORTABLE_EXPORT_EVIDENCE_FILENAME,
  );
  let published = false;

  try {
    const tables = await readPortableTableNames();
    const expectedBookmark = requireOpaque(
      options.expectedBookmark,
      "expectedBookmark",
    );
    const bookmarkBefore = await readD1Bookmark({
      wranglerEntry,
      wranglerConfig,
      database,
    });
    if (expectedBookmark !== bookmarkBefore) {
      throw new Error(
        "Current D1 bookmark does not match the control-plane write fence.",
      );
    }
    await runWrangler(wranglerEntry, [
      "d1",
      "export",
      database,
      "--remote",
      "--skip-confirmation",
      "--output",
      exportPath,
      "--config",
      wranglerConfig,
      ...tables.flatMap((table) => ["--table", table]),
    ]);
    const bookmarkAfter = await readD1Bookmark({
      wranglerEntry,
      wranglerConfig,
      database,
    });
    if (bookmarkAfter !== bookmarkBefore) {
      throw new Error(
        "D1 bookmark changed during export; the write fence did not hold.",
      );
    }
    await chmod(exportPath, 0o600);
    const artifact = await sha256File(exportPath);
    const tableSetSha256 = createHash("sha256")
      .update(tables.join("\n"))
      .digest("hex");
    const evidence: D1PortableExportEvidence = {
      version: D1_PORTABLE_EXPORT_VERSION,
      database,
      bookmark: bookmarkBefore,
      tables,
      tableSetSha256,
      artifact: {
        filename: D1_PORTABLE_EXPORT_FILENAME,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      },
    };
    await writeFile(
      evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporaryBundle, options.outputDirectory);
    published = true;
    return {
      bundle: options.outputDirectory,
      database,
      bookmark: bookmarkBefore,
      tableCount: tables.length,
      tableSetSha256,
      artifactBytes: artifact.bytes,
      artifactSha256: artifact.sha256,
    };
  } finally {
    if (!published) {
      await rm(temporaryBundle, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const summary = await exportD1PortableBundle(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
