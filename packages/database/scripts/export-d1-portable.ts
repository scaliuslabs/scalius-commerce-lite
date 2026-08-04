import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  mkdtemp,
  readFile,
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
import {
  isProviderDerivedSourceTable,
  RETIRED_PRE_CONSOLIDATION_TABLES,
} from "./normalize-d1-export-core";
import { sha256File } from "./turso-upload-bundle";

export const D1_PORTABLE_EXPORT_VERSION =
  "scalius-d1-portable-export/v3" as const;
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
  retiredTables: readonly string[];
  tableSetSha256: string;
  schemaObjectCount: number;
  schemaObjectSetSha256: string;
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
  retiredTableCount: number;
  tableSetSha256: string;
  schemaObjectCount: number;
  schemaObjectSetSha256: string;
  artifactBytes: number;
  artifactSha256: string;
}

export interface D1PortableSchemaObject {
  type: "index" | "trigger";
  name: string;
  table: string;
  sql: string;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function requireOpaque(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty opaque value.`);
  }
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

export function parseD1ExecuteTableNames(stdout: string): readonly string[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Wrangler returned an invalid D1 schema result.");
  }
  const result = parsed[0] as {
    success?: unknown;
    results?: unknown;
  };
  if (result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Wrangler did not return a successful D1 schema result.");
  }
  const names = result.results.map((row) => {
    const name = (row as { name?: unknown })?.name;
    if (typeof name !== "string" || !name) {
      throw new Error("Wrangler returned an invalid D1 table name.");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("Wrangler returned duplicate D1 table names.");
  }
  return names.sort((left, right) => left.localeCompare(right));
}

export function parseD1ExecuteSchemaObjects(
  stdout: string,
  exportedTables: readonly string[],
): readonly D1PortableSchemaObject[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Wrangler returned an invalid D1 schema-object result.");
  }
  const result = parsed[0] as { success?: unknown; results?: unknown };
  if (result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Wrangler did not return successful D1 schema objects.");
  }
  const allowedTables = new Set(exportedTables);
  const objects = result.results.flatMap((value) => {
    const row = value as {
      type?: unknown;
      name?: unknown;
      tbl_name?: unknown;
      sql?: unknown;
    };
    if (
      (row.type !== "index" && row.type !== "trigger")
      || typeof row.name !== "string"
      || typeof row.tbl_name !== "string"
      || typeof row.sql !== "string"
      || !row.name
      || !row.tbl_name
      || !row.sql.trim()
      || /[\0]/.test(row.sql)
    ) {
      throw new Error("Wrangler returned an invalid D1 schema object.");
    }
    if (
      !allowedTables.has(row.tbl_name)
      || isProviderDerivedSourceTable(row.name)
      || isProviderDerivedSourceTable(row.tbl_name)
    ) return [];
    return [{
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: `${row.sql.trim().replace(/;+$/, "")};`,
    } satisfies D1PortableSchemaObject];
  }).sort((left, right) =>
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
  if (new Set(objects.map(({ name }) => name)).size !== objects.length) {
    throw new Error("Wrangler returned duplicate D1 schema-object names.");
  }
  return objects;
}

async function readRemoteD1TableNames(input: {
  wranglerEntry: string;
  wranglerConfig: string;
  database: string;
}): Promise<readonly string[]> {
  const stdout = await runWrangler(input.wranglerEntry, [
    "d1",
    "execute",
    input.database,
    "--remote",
    "--json",
    "--command",
    "SELECT name FROM sqlite_schema WHERE type = 'table' "
      + "AND name NOT LIKE 'sqlite_%' ORDER BY name",
    "--config",
    input.wranglerConfig,
  ]);
  return parseD1ExecuteTableNames(stdout);
}

async function readRemoteD1SchemaObjects(input: {
  wranglerEntry: string;
  wranglerConfig: string;
  database: string;
  tables: readonly string[];
}): Promise<readonly D1PortableSchemaObject[]> {
  const stdout = await runWrangler(input.wranglerEntry, [
    "d1",
    "execute",
    input.database,
    "--remote",
    "--json",
    "--command",
    "SELECT type, name, tbl_name, sql FROM sqlite_schema "
      + "WHERE type IN ('index', 'trigger') AND sql IS NOT NULL "
      + "ORDER BY type, name",
    "--config",
    input.wranglerConfig,
  ]);
  return parseD1ExecuteSchemaObjects(stdout, input.tables);
}

export function classifyD1ExportTables(
  remoteTables: readonly string[],
  canonicalTables: readonly string[],
): { tables: readonly string[]; retiredTables: readonly string[] } {
  const remote = new Set(remoteTables);
  const canonical = new Set(canonicalTables);
  if (remote.size !== remoteTables.length || canonical.size !== canonicalTables.length) {
    throw new Error("D1 export table sets must be unique.");
  }
  const missing = canonicalTables.filter((table) => !remote.has(table));
  if (missing.length > 0) {
    throw new Error(`D1 source is missing canonical tables: ${missing.join(", ")}.`);
  }
  const unknown = remoteTables.filter((table) =>
    !canonical.has(table)
    && !RETIRED_PRE_CONSOLIDATION_TABLES.has(table)
    && !isProviderDerivedSourceTable(table));
  if (unknown.length > 0) {
    throw new Error(
      `D1 source contains unexpected noncanonical tables: ${unknown.join(", ")}.`,
    );
  }
  const retiredTables = remoteTables
    .filter((table) => RETIRED_PRE_CONSOLIDATION_TABLES.has(table))
    .sort((left, right) => left.localeCompare(right));
  return {
    tables: [...canonicalTables, ...retiredTables]
      .sort((left, right) => left.localeCompare(right)),
    retiredTables,
  };
}

export async function verifyD1PortableExportBundle(bundlePath: string): Promise<{
  bundlePath: string;
  sourcePath: string;
  evidencePath: string;
  evidenceSha256: string;
  evidence: D1PortableExportEvidence;
}> {
  const resolvedBundlePath = resolve(bundlePath);
  const sourcePath = join(resolvedBundlePath, D1_PORTABLE_EXPORT_FILENAME);
  const evidencePath = join(
    resolvedBundlePath,
    D1_PORTABLE_EXPORT_EVIDENCE_FILENAME,
  );
  const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as Partial<
    D1PortableExportEvidence
  >;
  if (parsed.version !== D1_PORTABLE_EXPORT_VERSION) {
    throw new Error(`Unsupported D1 portable export ${String(parsed.version)}.`);
  }
  const database = requireOpaque(parsed.database, "database");
  const bookmark = requireOpaque(parsed.bookmark, "bookmark");
  if (!Array.isArray(parsed.tables) || !Array.isArray(parsed.retiredTables)) {
    throw new Error("D1 portable export is missing table-set evidence.");
  }
  const tables = parsed.tables.map((table) => requireOpaque(table, "table"));
  const retiredTables = parsed.retiredTables.map((table) =>
    requireOpaque(table, "retiredTable"));
  const canonicalTables = await readPortableTableNames();
  const classified = classifyD1ExportTables(tables, canonicalTables);
  if (
    JSON.stringify(tables) !== JSON.stringify(classified.tables)
    || JSON.stringify(retiredTables) !== JSON.stringify(classified.retiredTables)
  ) {
    throw new Error("D1 portable export table evidence is not canonical and sorted.");
  }
  const tableSetSha256 = createHash("sha256")
    .update(tables.join("\n"))
    .digest("hex");
  if (parsed.tableSetSha256 !== tableSetSha256) {
    throw new Error("D1 portable export table-set digest does not match evidence.");
  }
  const schemaObjectCount = requireNonNegativeSafeInteger(
    parsed.schemaObjectCount,
    "schemaObjectCount",
  );
  const schemaObjectSetSha256 = requireSha256(
    parsed.schemaObjectSetSha256,
    "schemaObjectSetSha256",
  );
  if (parsed.artifact?.filename !== D1_PORTABLE_EXPORT_FILENAME) {
    throw new Error("D1 portable export names an unexpected source artifact.");
  }
  const expectedBytes = requireNonNegativeSafeInteger(
    parsed.artifact.bytes,
    "artifact.bytes",
  );
  const expectedSha256 = requireSha256(
    parsed.artifact.sha256,
    "artifact.sha256",
  );
  const artifact = await sha256File(sourcePath);
  if (artifact.bytes !== expectedBytes || artifact.sha256 !== expectedSha256) {
    throw new Error("D1 portable export source artifact does not match its evidence.");
  }
  return {
    bundlePath: resolvedBundlePath,
    sourcePath,
    evidencePath,
    evidenceSha256: (await sha256File(evidencePath)).sha256,
    evidence: {
      version: D1_PORTABLE_EXPORT_VERSION,
      database,
      bookmark,
      tables,
      retiredTables,
      tableSetSha256,
      schemaObjectCount,
      schemaObjectSetSha256,
      artifact: {
        filename: D1_PORTABLE_EXPORT_FILENAME,
        bytes: expectedBytes,
        sha256: expectedSha256,
      },
    },
  };
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
    const canonicalTables = await readPortableTableNames();
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
    const remoteTables = await readRemoteD1TableNames({
      wranglerEntry,
      wranglerConfig,
      database,
    });
    const { tables, retiredTables } = classifyD1ExportTables(
      remoteTables,
      canonicalTables,
    );
    const schemaObjects = await readRemoteD1SchemaObjects({
      wranglerEntry,
      wranglerConfig,
      database,
      tables,
    });
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
    await appendFile(
      exportPath,
      `\n${schemaObjects.map(({ sql }) => sql).join("\n")}\n`,
      { mode: 0o600 },
    );
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
    const schemaObjectSetSha256 = createHash("sha256")
      .update(JSON.stringify(schemaObjects))
      .digest("hex");
    const evidence: D1PortableExportEvidence = {
      version: D1_PORTABLE_EXPORT_VERSION,
      database,
      bookmark: bookmarkBefore,
      tables,
      retiredTables,
      tableSetSha256,
      schemaObjectCount: schemaObjects.length,
      schemaObjectSetSha256,
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
      retiredTableCount: retiredTables.length,
      tableSetSha256,
      schemaObjectCount: schemaObjects.length,
      schemaObjectSetSha256,
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
