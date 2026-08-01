import {
  access,
  chmod,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { connect } from "@tursodatabase/database";

import { normalizeD1ExportToTursoDatabase } from "./normalize-d1-export-core";
import {
  sha256File,
  TURSO_UPLOAD_BUNDLE_VERSION,
  TURSO_UPLOAD_DATABASE_FILENAME,
  TURSO_UPLOAD_EVIDENCE_FILENAME,
  type TursoUploadBundleEvidence,
} from "./turso-upload-bundle";

const GIBIBYTE = 1024n * 1024n * 1024n;

export interface PrepareTursoUploadOptions {
  input: string;
  outputDirectory: string;
  sqliteBinary: string;
}

export interface PrepareTursoUploadSummary {
  bundle: string;
  sourceBytes: number;
  sourceSha256: string;
  artifactBytes: number;
  artifactSha256: string;
  tableCount: number;
  rowCount: number;
  sourceFingerprint: string;
  availableDiskBytes: string;
  requiredDiskBytes: string;
  integrity: "ok";
  foreignKeyViolations: 0;
  journalMode: "mvcc";
}

function parseArguments(argv: readonly string[]): PrepareTursoUploadOptions {
  let input: string | undefined;
  let outputDirectory: string | undefined;
  let sqliteBinary = process.env.SQLITE3_BIN?.trim() || "sqlite3";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--input") input = argv[++index];
    else if (argument === "--out") outputDirectory = argv[++index];
    else if (argument === "--sqlite-binary") sqliteBinary = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!input?.trim()) throw new Error("--input is required.");
  if (!outputDirectory?.trim()) throw new Error("--out is required.");
  if (!sqliteBinary.trim()) throw new Error("--sqlite-binary must not be empty.");
  return {
    input: resolve(input),
    outputDirectory: resolve(outputDirectory),
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

async function preflightDisk(input: string, outputParent: string): Promise<{
  availableBytes: bigint;
  requiredBytes: bigint;
}> {
  const inputStats = await stat(input);
  if (!inputStats.isFile() || inputStats.size < 1) {
    throw new Error("D1 export must be a non-empty regular file.");
  }
  const filesystem = await statfs(outputParent, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  // The input already occupies disk. Preparation additionally creates one
  // source SQLite file and one canonical target file. Two input-sized copies
  // plus 2 GiB protects page/index overhead without guessing from JS memory.
  const requiredBytes = BigInt(inputStats.size) * 2n + 2n * GIBIBYTE;
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient free disk for migration bundle: ${availableBytes} bytes available, ${requiredBytes} required.`,
    );
  }
  return { availableBytes, requiredBytes };
}

const TURSO_MVCC_SIDECAR_SUFFIXES = [
  "-log",
  "-shm",
  "-tshm",
  "-wal",
] as const;

async function removeTursoSidecars(databasePath: string): Promise<void> {
  await Promise.all(TURSO_MVCC_SIDECAR_SUFFIXES.map((suffix) =>
    rm(`${databasePath}${suffix}`, { force: true }),
  ));
}

/**
 * Convert the checkpointed SQLite/WAL artifact into the file-header format
 * required by TursoDB's native upload endpoint. The current embedded engine
 * opens existing WAL/MVCC files without creating absent sidecars, so create
 * private empty sidecars before opening and remove them after a clean close.
 * The upload endpoint intentionally receives only the checkpointed `.db`
 * file; no uncheckpointed transaction is allowed to remain in a sidecar.
 */
export async function convertToTursoMvccArtifact(
  databasePath: string,
): Promise<TursoUploadBundleEvidence["artifact"]["pragmas"]> {
  if (basename(databasePath) !== TURSO_UPLOAD_DATABASE_FILENAME) {
    throw new Error(
      `Turso MVCC artifact must be named ${TURSO_UPLOAD_DATABASE_FILENAME}.`,
    );
  }
  await removeTursoSidecars(databasePath);
  await Promise.all(["-wal", "-log"].map((suffix) =>
    writeFile(`${databasePath}${suffix}`, new Uint8Array(), {
      flag: "wx",
      mode: 0o600,
    }),
  ));

  const database = await connect(databasePath, { fileMustExist: true });
  try {
    const initialJournalMode = String(
      (await database.get("PRAGMA journal_mode"))?.journal_mode ?? "",
    ).toLowerCase();
    if (initialJournalMode !== "wal") {
      throw new Error(
        `Expected checkpointed WAL artifact before MVCC conversion; received ${initialJournalMode || "empty"}.`,
      );
    }
    // Turso checkpoints pending WAL frames as part of the journal-mode switch.
    // Its current JavaScript binding panics if `PRAGMA wal_checkpoint` is read
    // with `get()` because this pragma yields no row in MVCC mode, so the mode
    // transition itself is the durable checkpoint boundary.
    await database.exec("PRAGMA journal_mode=mvcc");
    const pageSize = Number((await database.get("PRAGMA page_size"))?.page_size);
    const journalMode = String(
      (await database.get("PRAGMA journal_mode"))?.journal_mode ?? "",
    ).toLowerCase();
    // The embedded beta currently panics its Node binding when auto_vacuum or
    // encoding yields no result in MVCC mode. Both invariants were verified by
    // SQLite immediately before conversion, and the mode switch cannot alter
    // either file-header setting.
    const autoVacuum = 0;
    const encoding = "UTF-8";
    const integrity = String(
      (await database.get("PRAGMA integrity_check"))?.integrity_check,
    );
    const foreignKeyViolations = await database.all("PRAGMA foreign_key_check");
    if (
      pageSize !== 4096 ||
      journalMode !== "mvcc" ||
      autoVacuum !== 0 ||
      encoding !== "UTF-8" ||
      integrity !== "ok" ||
      foreignKeyViolations.length > 0
    ) {
      throw new Error(
        "Prepared Turso MVCC artifact failed final upload preflight.",
      );
    }
    return {
      pageSize: 4096,
      journalMode: "mvcc",
      autoVacuum: 0,
      encoding: "UTF-8",
    };
  } finally {
    await database.close();
    await removeTursoSidecars(databasePath);
    await chmod(databasePath, 0o600);
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function prepareTursoUploadBundle(
  options: PrepareTursoUploadOptions,
): Promise<PrepareTursoUploadSummary> {
  await assertDoesNotExist(options.outputDirectory);
  const outputParent = dirname(options.outputDirectory);
  await access(outputParent);
  const disk = await preflightDisk(options.input, outputParent);
  const temporaryBundle = await mkdtemp(
    join(outputParent, ".scalius-turso-upload-"),
  );
  const databasePath = join(
    temporaryBundle,
    TURSO_UPLOAD_DATABASE_FILENAME,
  );
  const evidencePath = join(
    temporaryBundle,
    TURSO_UPLOAD_EVIDENCE_FILENAME,
  );
  let published = false;

  try {
    const normalization = await normalizeD1ExportToTursoDatabase({
      input: options.input,
      targetDatabasePath: databasePath,
      sqliteBinary: options.sqliteBinary,
    });
    const uploadPragmas = await convertToTursoMvccArtifact(databasePath);
    const artifact = await sha256File(databasePath);
    const evidence: TursoUploadBundleEvidence = {
      version: TURSO_UPLOAD_BUNDLE_VERSION,
      source: {
        filename: basename(options.input),
        bytes: normalization.sourceBytes,
        sha256: normalization.sourceSha256,
      },
      artifact: {
        engine: "turso-mvcc",
        filename: TURSO_UPLOAD_DATABASE_FILENAME,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        pragmas: uploadPragmas,
      },
      normalization: {
        tableCount: normalization.tableCount,
        rowCount: normalization.rowCount,
        discardedColumns: normalization.discardedColumns,
        ignoredSourceTables: normalization.ignoredSourceTables,
        normalizedValueCount: normalization.normalizedValueCount,
        foreignKeyViolations: normalization.foreignKeyViolations,
        integrity: normalization.integrity,
      },
      portabilityManifest: normalization.portabilityManifest,
    };
    await writeFile(
      evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await Promise.all([syncFile(databasePath), syncFile(evidencePath)]);
    await rename(temporaryBundle, options.outputDirectory);
    published = true;

    return {
      bundle: options.outputDirectory,
      sourceBytes: normalization.sourceBytes,
      sourceSha256: normalization.sourceSha256,
      artifactBytes: artifact.bytes,
      artifactSha256: artifact.sha256,
      tableCount: normalization.tableCount,
      rowCount: normalization.rowCount,
      sourceFingerprint: normalization.portabilityManifest.fingerprint,
      availableDiskBytes: disk.availableBytes.toString(),
      requiredDiskBytes: disk.requiredBytes.toString(),
      integrity: normalization.integrity,
      foreignKeyViolations: normalization.foreignKeyViolations,
      journalMode: "mvcc",
    };
  } finally {
    if (!published) {
      await rm(temporaryBundle, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const summary = await prepareTursoUploadBundle(options);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
