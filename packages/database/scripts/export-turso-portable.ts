import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { connect as connectEmbedded } from "@tursodatabase/database";
import {
  connect as connectSync,
  type DatabaseOpts as TursoSyncOptions,
} from "@tursodatabase/sync";

import {
  createSqlitePortabilityManifest,
  type SqlitePortabilityExecutor,
  verifySqlitePortabilityManifests,
} from "../src/portability";
import {
  normalizeSqliteDatabaseToTursoDatabase,
  type D1NormalizationReceipt,
  verifyRetiredSchemaArchiveContents,
} from "./normalize-d1-export-core";
import { sha256File } from "./turso-upload-bundle";

export const TURSO_PORTABLE_EXPORT_VERSION =
  "scalius-turso-portable-export/v2" as const;
export const TURSO_PORTABLE_EXPORT_FILENAME = "source.sqlite3" as const;
export const TURSO_PORTABLE_EXPORT_EVIDENCE_FILENAME =
  "export-evidence.json" as const;
export const TURSO_PORTABLE_RETIRED_ARCHIVE_FILENAME =
  "retired-schema-archive.sqlite3" as const;

const REQUIRED_STABLE_PULLS = 2;
const MAX_PULL_ATTEMPTS = 64;

interface TursoSyncStats {
  cdcOperations: number;
  mainWalSize: number;
  revertWalSize: number;
  revision: string | null;
  networkReceivedBytes: number;
}

export interface TursoSyncSession {
  pull(): Promise<boolean>;
  checkpoint(): Promise<void>;
  stats(): Promise<TursoSyncStats>;
  close(): Promise<void>;
}

interface EmbeddedDatabase {
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface TursoPortableExportDependencies {
  connectSync(options: TursoSyncOptions): Promise<TursoSyncSession>;
  convertSyncedDatabase(path: string): Promise<void>;
}

export interface ExportTursoPortableOptions {
  databaseUrl: string;
  authToken?: string;
  acknowledgedSourceHost: string;
  outputDirectory: string;
  pullBytesThreshold?: number;
  snapshotPath?: string;
  snapshotRevision?: string;
}

export interface TursoPortableExportEvidence {
  version: typeof TURSO_PORTABLE_EXPORT_VERSION;
  provider: "turso";
  source: {
    host: string;
    revision: string;
    acquisition: "sync" | "platform-export";
  };
  sync: {
    pullAttempts: number;
    changedPulls: number;
    stablePulls: typeof REQUIRED_STABLE_PULLS;
    networkReceivedBytes: number;
    pendingLocalOperations: 0;
    mainWalBytes: number;
    revertWalBytes: number;
  } | null;
  artifact: {
    filename: typeof TURSO_PORTABLE_EXPORT_FILENAME;
    bytes: number;
    sha256: string;
  };
  normalization: D1NormalizationReceipt;
}

export interface TursoPortableExportSummary {
  bundle: string;
  sourceHost: string;
  sourceRevision: string;
  tableCount: number;
  rowCount: number;
  artifactBytes: number;
  artifactSha256: string;
  retiredArchiveSha256: string | null;
}

interface StableSnapshotReceipt {
  revision: string;
  pullAttempts: number;
  changedPulls: number;
  networkReceivedBytes: number;
  mainWalBytes: number;
  revertWalBytes: number;
}

const realDependencies: TursoPortableExportDependencies = {
  connectSync: async (options) => connectSync(options),
  convertSyncedDatabase: async (path) => convertSyncedTursoDatabase(path),
};

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
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
  if (!normalized || normalized.length > 2_000 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} must be a non-empty opaque value.`);
  }
  return normalized;
}

export function parseAndAcknowledgeTursoSource(
  databaseUrl: string,
  acknowledgedHost: string,
): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("TURSO_DATABASE_URL must be a valid Turso URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !["turso:", "libsql:", "https:"].includes(parsed.protocol)
    || !host
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      "TURSO_DATABASE_URL must be a credential-free Turso URL without query or fragment.",
    );
  }
  if (host !== acknowledgedHost.trim().toLowerCase()) {
    throw new Error("Turso source host does not exactly match its acknowledgement.");
  }
  return { url: parsed.toString(), host };
}

function parseArguments(argv: readonly string[]): ExportTursoPortableOptions {
  let outputDirectory: string | undefined;
  let acknowledgedSourceHost: string | undefined;
  let pullBytesThreshold: number | undefined;
  let snapshotPath: string | undefined;
  let snapshotRevision: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--out") outputDirectory = argv[++index];
    else if (argument === "--ack-source-host") acknowledgedSourceHost = argv[++index];
    else if (argument === "--snapshot") snapshotPath = argv[++index];
    else if (argument === "--snapshot-revision") snapshotRevision = argv[++index];
    else if (argument === "--pull-bytes-threshold") {
      pullBytesThreshold = Number(argv[++index]);
    } else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!outputDirectory?.trim()) throw new Error("--out is required.");
  if (!acknowledgedSourceHost?.trim()) {
    throw new Error("--ack-source-host is required.");
  }
  if (snapshotPath && !snapshotRevision?.trim()) {
    throw new Error("--snapshot-revision is required with --snapshot.");
  }
  if (snapshotRevision && !snapshotPath?.trim()) {
    throw new Error("--snapshot is required with --snapshot-revision.");
  }
  if (pullBytesThreshold !== undefined) {
    if (
      !Number.isSafeInteger(pullBytesThreshold)
      || pullBytesThreshold < 1024 * 1024
      || pullBytesThreshold > 1024 * 1024 * 1024
    ) {
      throw new Error("--pull-bytes-threshold must be between 1 MiB and 1 GiB.");
    }
    if (snapshotPath) {
      throw new Error("--pull-bytes-threshold cannot be used with --snapshot.");
    }
  }
  return {
    databaseUrl: requireEnvironment("TURSO_DATABASE_URL"),
    authToken: snapshotPath ? undefined : requireEnvironment("TURSO_AUTH_TOKEN"),
    acknowledgedSourceHost,
    outputDirectory: resolve(outputDirectory),
    pullBytesThreshold,
    snapshotPath: snapshotPath ? resolve(snapshotPath) : undefined,
    snapshotRevision,
  };
}

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Refusing to overwrite ${path}.`);
}

function validateSyncStats(stats: TursoSyncStats): void {
  requireSafeInteger(stats.cdcOperations, "Turso pending local operations");
  requireSafeInteger(stats.mainWalSize, "Turso main WAL bytes");
  requireSafeInteger(stats.revertWalSize, "Turso revert WAL bytes");
  requireSafeInteger(stats.networkReceivedBytes, "Turso received bytes");
  if (stats.cdcOperations !== 0) {
    throw new Error("Turso export contains local writes that were not part of the source.");
  }
}

export async function pullFrozenTursoSnapshot(
  database: TursoSyncSession,
): Promise<StableSnapshotReceipt> {
  let stablePulls = 0;
  let pullAttempts = 0;
  let changedPulls = 0;
  while (stablePulls < REQUIRED_STABLE_PULLS && pullAttempts < MAX_PULL_ATTEMPTS) {
    const changed = await database.pull();
    pullAttempts += 1;
    if (changed) {
      changedPulls += 1;
      stablePulls = 0;
    } else {
      stablePulls += 1;
    }
  }
  if (stablePulls !== REQUIRED_STABLE_PULLS) {
    throw new Error(
      "Turso source did not settle after the bounded pull window; keep it frozen and retry.",
    );
  }
  const beforeCheckpoint = await database.stats();
  validateSyncStats(beforeCheckpoint);
  const revision = requireOpaque(beforeCheckpoint.revision, "Turso source revision");
  await database.checkpoint();
  const afterCheckpoint = await database.stats();
  validateSyncStats(afterCheckpoint);
  if (requireOpaque(afterCheckpoint.revision, "Turso source revision") !== revision) {
    throw new Error("Turso source revision changed while checkpointing the frozen export.");
  }
  return {
    revision,
    pullAttempts,
    changedPulls,
    networkReceivedBytes: afterCheckpoint.networkReceivedBytes,
    mainWalBytes: afterCheckpoint.mainWalSize,
    revertWalBytes: afterCheckpoint.revertWalSize,
  };
}

async function removeCheckpointedSidecars(path: string): Promise<void> {
  for (const suffix of ["-journal", "-wal", "-changes", "-log"]) {
    try {
      const sidecar = await stat(`${path}${suffix}`);
      if (!sidecar.isFile() || sidecar.size !== 0) {
        throw new Error(
          `Turso export retained data in ${suffix.slice(1)} after checkpoint.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  await Promise.all([
    "-journal",
    "-wal",
    "-changes",
    "-log",
    "-info",
    "-shm",
    "-tshm",
  ].map((suffix) => rm(`${path}${suffix}`, { force: true })));
}

export async function convertSyncedTursoDatabase(
  path: string,
  openEmbedded: (path: string) => Promise<EmbeddedDatabase> = async (location) =>
    connectEmbedded(location),
): Promise<void> {
  const embedded = await openEmbedded(path);
  try {
    // Turso Sync stores the main file in MVCC format. Switching to WAL through
    // the embedded engine materializes an ordinary SQLite file without a SQL
    // dump, so memory stays independent of database size.
    await embedded.exec("PRAGMA journal_mode=WAL;");
    await embedded.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    await embedded.close();
  }

  const sqlite = new DatabaseSync(path);
  try {
    const checkpoint = sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(checkpoint?.busy ?? 1) !== 0) {
      throw new Error("Converted Turso snapshot retained a busy WAL checkpoint.");
    }
    const journalMode = String(
      sqlite.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode ?? "",
    ).toLowerCase();
    if (journalMode !== "delete") {
      throw new Error("Converted Turso snapshot did not enter SQLite DELETE mode.");
    }
    const integrity = String(
      sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
    ).toLowerCase();
    if (integrity !== "ok") {
      throw new Error("Converted Turso snapshot failed SQLite integrity_check.");
    }
  } finally {
    sqlite.close();
  }
  await removeCheckpointedSidecars(path);
  await chmod(path, 0o600);
}

async function copyPlatformExportSnapshot(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size <= 0) {
    throw new Error("Turso platform export snapshot must be a non-empty file.");
  }
  await copyFile(sourcePath, targetPath);
  await chmod(targetPath, 0o600);
  let sidecarCount = 0;
  for (const suffix of ["-wal", "-log"] as const) {
    try {
      const sidecar = await stat(`${sourcePath}${suffix}`);
      if (!sidecar.isFile()) {
        throw new Error(`Turso platform export ${suffix.slice(1)} sidecar is not a file.`);
      }
      await copyFile(`${sourcePath}${suffix}`, `${targetPath}${suffix}`);
      await chmod(`${targetPath}${suffix}`, 0o600);
      sidecarCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  if (sidecarCount !== 1) {
    throw new Error(
      "Turso platform export must include exactly one -wal or -log sidecar.",
    );
  }
}

function createNodeSqliteExecutor(database: DatabaseSync): SqlitePortabilityExecutor {
  return {
    async query(sql, params = []) {
      const statement = database.prepare(sql);
      return statement.all(...params.map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      )) as Record<string, unknown>[];
    },
  };
}

async function writeEvidence(
  path: string,
  evidence: TursoPortableExportEvidence,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function exportTursoPortable(
  options: ExportTursoPortableOptions,
  dependencies: TursoPortableExportDependencies = realDependencies,
): Promise<TursoPortableExportSummary> {
  const source = parseAndAcknowledgeTursoSource(
    options.databaseUrl,
    options.acknowledgedSourceHost,
  );
  const snapshotPath = options.snapshotPath?.trim()
    ? resolve(options.snapshotPath)
    : undefined;
  const snapshotRevision = snapshotPath
    ? requireOpaque(options.snapshotRevision, "Turso platform export revision")
    : undefined;
  if (
    !snapshotPath
    && (!options.authToken?.trim() || /[\r\n\0]/.test(options.authToken))
  ) {
    throw new Error("TURSO_AUTH_TOKEN is invalid.");
  }
  const outputDirectory = resolve(options.outputDirectory);
  await assertMissing(outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true });
  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), ".scalius-turso-export-"),
  );
  await chmod(stagingDirectory, 0o700);
  // Turso Sync derives sidecar names from a `.db` basename. Using another
  // extension can leave a second derived `*.db-log` name outside the exact
  // cleanup set even after the main file is checkpointed.
  const rawPath = join(stagingDirectory, ".source-sync.db");
  const artifactPath = join(stagingDirectory, TURSO_PORTABLE_EXPORT_FILENAME);
  const archivePath = join(
    stagingDirectory,
    TURSO_PORTABLE_RETIRED_ARCHIVE_FILENAME,
  );
  let succeeded = false;
  let session: TursoSyncSession | undefined;
  try {
    let snapshot: StableSnapshotReceipt;
    let acquisition: TursoPortableExportEvidence["source"]["acquisition"];
    if (snapshotPath) {
      await copyPlatformExportSnapshot(snapshotPath, rawPath);
      snapshot = {
        revision: snapshotRevision!,
        pullAttempts: 0,
        changedPulls: 0,
        networkReceivedBytes: 0,
        mainWalBytes: 0,
        revertWalBytes: 0,
      };
      acquisition = "platform-export";
    } else {
      session = await dependencies.connectSync({
        path: rawPath,
        url: source.url,
        authToken: options.authToken!,
        clientName: "scalius-frozen-migration-export",
        ...(options.pullBytesThreshold === undefined
          ? {}
          : { pullBytesThreshold: options.pullBytesThreshold }),
      });
      snapshot = await pullFrozenTursoSnapshot(session);
      await session.close();
      session = undefined;
      acquisition = "sync";
    }

    await dependencies.convertSyncedDatabase(rawPath);
    const rawStat = await stat(rawPath);
    if (!rawStat.isFile() || rawStat.size <= 0) {
      throw new Error("Turso sync did not create a portable source file.");
    }
    const rawArtifact = await sha256File(rawPath);
    const normalization = await normalizeSqliteDatabaseToTursoDatabase({
      sourcePath: rawPath,
      sourceFilename: "turso-frozen-snapshot.sqlite3",
      sourceBytes: rawStat.size,
      sourceSha256: rawArtifact.sha256,
      sourceProvider: "turso",
      targetDatabasePath: artifactPath,
      targetJournalMode: "delete",
      retiredSchemaArchivePath: archivePath,
    });
    const artifactStat = await stat(artifactPath);
    const artifactSha256 = (await sha256File(artifactPath)).sha256;
    const evidence: TursoPortableExportEvidence = {
      version: TURSO_PORTABLE_EXPORT_VERSION,
      provider: "turso",
      source: {
        host: source.host,
        revision: snapshot.revision,
        acquisition,
      },
      sync: acquisition === "sync"
        ? {
          pullAttempts: snapshot.pullAttempts,
          changedPulls: snapshot.changedPulls,
          stablePulls: REQUIRED_STABLE_PULLS,
          networkReceivedBytes: snapshot.networkReceivedBytes,
          pendingLocalOperations: 0,
          mainWalBytes: snapshot.mainWalBytes,
          revertWalBytes: snapshot.revertWalBytes,
        }
        : null,
      artifact: {
        filename: TURSO_PORTABLE_EXPORT_FILENAME,
        bytes: artifactStat.size,
        sha256: artifactSha256,
      },
      normalization,
    };
    await writeEvidence(
      join(stagingDirectory, TURSO_PORTABLE_EXPORT_EVIDENCE_FILENAME),
      evidence,
    );
    await rm(rawPath, { force: true });
    await rename(stagingDirectory, outputDirectory);
    succeeded = true;
    return {
      bundle: outputDirectory,
      sourceHost: source.host,
      sourceRevision: snapshot.revision,
      tableCount: normalization.tableCount,
      rowCount: normalization.rowCount,
      artifactBytes: artifactStat.size,
      artifactSha256,
      retiredArchiveSha256:
        normalization.retiredSchemaArchive?.sha256 ?? null,
    };
  } finally {
    await session?.close().catch(() => undefined);
    if (!succeeded) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

function parseEvidence(value: unknown): TursoPortableExportEvidence {
  if (!value || typeof value !== "object") {
    throw new Error("Turso export evidence must be an object.");
  }
  const evidence = value as Partial<TursoPortableExportEvidence>;
  if (evidence.version !== TURSO_PORTABLE_EXPORT_VERSION || evidence.provider !== "turso") {
    throw new Error("Turso export evidence has an unsupported version or provider.");
  }
  const source = evidence.source as TursoPortableExportEvidence["source"] | undefined;
  if (!source || !/^[a-z0-9.-]+$/.test(source.host ?? "")) {
    throw new Error("Turso export evidence has an invalid source host.");
  }
  requireOpaque(source.revision, "Turso export revision");
  if (source.acquisition !== "sync" && source.acquisition !== "platform-export") {
    throw new Error("Turso export evidence has an invalid acquisition method.");
  }
  const sync = evidence.sync as TursoPortableExportEvidence["sync"] | undefined;
  if (source.acquisition === "sync") {
    if (!sync || sync.stablePulls !== REQUIRED_STABLE_PULLS || sync.pendingLocalOperations !== 0) {
      throw new Error("Turso export evidence does not prove a stable read-only snapshot.");
    }
    for (const [label, number] of [
      ["pull attempts", sync.pullAttempts],
      ["changed pulls", sync.changedPulls],
      ["received bytes", sync.networkReceivedBytes],
      ["main WAL bytes", sync.mainWalBytes],
      ["revert WAL bytes", sync.revertWalBytes],
    ] as const) requireSafeInteger(number, `Turso export ${label}`);
  } else if (sync !== null) {
    throw new Error("Turso platform export evidence must not contain Sync claims.");
  }
  const artifact = evidence.artifact as TursoPortableExportEvidence["artifact"] | undefined;
  if (!artifact || artifact.filename !== TURSO_PORTABLE_EXPORT_FILENAME) {
    throw new Error("Turso export evidence names an invalid artifact.");
  }
  requireSafeInteger(artifact.bytes, "Turso export artifact bytes");
  requireSha256(artifact.sha256, "Turso export artifact SHA-256");
  const normalization = evidence.normalization as D1NormalizationReceipt | undefined;
  if (
    !normalization
    || normalization.integrity !== "ok"
    || normalization.foreignKeyViolations !== 0
    || normalization.uploadPragmas?.journalMode !== "delete"
  ) {
    throw new Error("Turso export evidence has invalid normalization proof.");
  }
  requireSafeInteger(normalization.tableCount, "Turso export normalized table count");
  requireSafeInteger(normalization.rowCount, "Turso export normalized row count");
  requireSha256(normalization.sourceSha256, "Turso export raw source SHA-256");
  return evidence as TursoPortableExportEvidence;
}

export async function verifyTursoPortableExportBundle(bundle: string): Promise<{
  bundlePath: string;
  sourcePath: string;
  evidencePath: string;
  evidenceSha256: string;
  evidence: TursoPortableExportEvidence;
}> {
  const bundlePath = resolve(bundle);
  const sourcePath = join(bundlePath, TURSO_PORTABLE_EXPORT_FILENAME);
  const evidencePath = join(
    bundlePath,
    TURSO_PORTABLE_EXPORT_EVIDENCE_FILENAME,
  );
  const evidence = parseEvidence(JSON.parse(await readFile(evidencePath, "utf8")));
  const artifact = await stat(sourcePath);
  if (
    !artifact.isFile()
    || artifact.size !== evidence.artifact.bytes
    || (await sha256File(sourcePath)).sha256 !== evidence.artifact.sha256
  ) {
    throw new Error("Turso portable source artifact does not match its evidence.");
  }
  const allowedFiles = new Set([
    TURSO_PORTABLE_EXPORT_FILENAME,
    TURSO_PORTABLE_EXPORT_EVIDENCE_FILENAME,
  ]);
  const retired = evidence.normalization.retiredSchemaArchive;
  if (retired) {
    if (retired.filename !== TURSO_PORTABLE_RETIRED_ARCHIVE_FILENAME) {
      throw new Error("Turso retired-schema archive has an invalid filename.");
    }
    allowedFiles.add(TURSO_PORTABLE_RETIRED_ARCHIVE_FILENAME);
    const archivePath = join(bundlePath, retired.filename);
    const archive = await stat(archivePath);
    if (
      !archive.isFile()
      || archive.size !== retired.bytes
      || (await sha256File(archivePath)).sha256 !== retired.sha256
    ) {
      throw new Error("Turso retired-schema archive does not match its evidence.");
    }
    verifyRetiredSchemaArchiveContents(archivePath, retired);
  }
  const files = (await readdir(bundlePath)).sort();
  if (
    files.length !== allowedFiles.size
    || files.some((file) => !allowedFiles.has(file))
  ) {
    throw new Error("Turso portable export bundle contains unexpected files.");
  }

  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const integrity = String(
      database.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
    ).toLowerCase();
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (integrity !== "ok" || foreignKeys.length > 0) {
      throw new Error("Turso portable source failed SQLite integrity verification.");
    }
    const manifest = await createSqlitePortabilityManifest(
      createNodeSqliteExecutor(database),
      { chunkSize: evidence.normalization.portabilityManifest.chunkSize },
    );
    const comparison = verifySqlitePortabilityManifests(
      evidence.normalization.portabilityManifest,
      manifest,
    );
    if (!comparison.ok) {
      throw new Error("Turso portable source manifest does not match its evidence.");
    }
  } finally {
    database.close();
  }
  return {
    bundlePath,
    sourcePath,
    evidencePath,
    evidenceSha256: (await sha256File(evidencePath)).sha256,
    evidence,
  };
}

async function main(): Promise<void> {
  const summary = await exportTursoPortable(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Turso portable export failed."}\n`,
    );
    process.exitCode = 1;
  });
}
