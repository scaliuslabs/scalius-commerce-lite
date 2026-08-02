import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { SqlitePortabilityManifest } from "../src/portability";
import {
  verifyRetiredSchemaArchiveContents,
  type IgnoredSourceTable,
  type RetiredSchemaArchiveReceipt,
  type TursoUploadPragmas,
} from "./normalize-d1-export-core";

export const TURSO_UPLOAD_BUNDLE_VERSION =
  "scalius-turso-upload-bundle/v4" as const;
// Turso's embedded MVCC implementation derives `database.db-log` from this
// exact suffix. A `.sqlite3` filename currently produces a mismatched log
// path during `PRAGMA journal_mode=mvcc`, so keep the portable artifact on the
// provider's supported `.db` path shape.
export const TURSO_UPLOAD_DATABASE_FILENAME = "database.db";
export const TURSO_UPLOAD_EVIDENCE_FILENAME = "evidence.json";
export const TURSO_UPLOAD_RETIRED_SCHEMA_ARCHIVE_FILENAME =
  "retired-schema-archive.sqlite3" as const;

export interface TursoUploadBundleEvidence {
  version: typeof TURSO_UPLOAD_BUNDLE_VERSION;
  source: {
    filename: string;
    bytes: number;
    sha256: string;
    portableExport: {
      version: "scalius-d1-portable-export/v2";
      database: string;
      snapshotRef: string;
      evidenceSha256: string;
    } | null;
  };
  artifact: {
    engine: "turso-mvcc";
    filename: typeof TURSO_UPLOAD_DATABASE_FILENAME;
    bytes: number;
    sha256: string;
    pragmas: TursoUploadPragmas;
  };
  normalization: {
    tableCount: number;
    rowCount: number;
    discardedColumns: readonly string[];
    ignoredSourceTables: readonly IgnoredSourceTable[];
    normalizedValueCount: number;
    foreignKeyViolations: 0;
    integrity: "ok";
  };
  retiredSchemaArchive: RetiredSchemaArchiveReceipt | null;
  portabilityManifest: SqlitePortabilityManifest;
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

export async function sha256File(path: string): Promise<{
  bytes: number;
  sha256: string;
}> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function readTursoUploadBundle(bundlePath: string): Promise<{
  bundlePath: string;
  databasePath: string;
  evidencePath: string;
  evidence: TursoUploadBundleEvidence;
}> {
  const resolvedBundlePath = resolve(bundlePath);
  const evidencePath = join(
    resolvedBundlePath,
    TURSO_UPLOAD_EVIDENCE_FILENAME,
  );
  const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as Partial<
    TursoUploadBundleEvidence
  >;
  if (parsed.version !== TURSO_UPLOAD_BUNDLE_VERSION) {
    throw new Error(`Unsupported Turso upload bundle ${String(parsed.version)}.`);
  }
  if (parsed.artifact?.filename !== TURSO_UPLOAD_DATABASE_FILENAME) {
    throw new Error("Turso upload bundle names an unexpected database artifact.");
  }
  if (parsed.artifact.engine !== "turso-mvcc") {
    throw new Error("Turso upload bundle is not a Turso MVCC artifact.");
  }
  if (typeof parsed.source?.filename !== "string" || !parsed.source.filename) {
    throw new Error("Turso upload bundle is missing its source filename.");
  }
  requireNonNegativeSafeInteger(parsed.source.bytes, "source.bytes");
  requireSha256(parsed.source.sha256, "source.sha256");
  if (parsed.source.portableExport !== null) {
    const portableExport = parsed.source.portableExport;
    if (
      !portableExport
      || portableExport.version !== "scalius-d1-portable-export/v2"
      || typeof portableExport.database !== "string"
      || !portableExport.database
      || typeof portableExport.snapshotRef !== "string"
      || !portableExport.snapshotRef
    ) {
      throw new Error("Turso upload bundle has invalid D1 export evidence.");
    }
    requireSha256(
      portableExport.evidenceSha256,
      "source.portableExport.evidenceSha256",
    );
  }
  requireNonNegativeSafeInteger(parsed.artifact.bytes, "artifact.bytes");
  requireSha256(parsed.artifact.sha256, "artifact.sha256");
  if (!parsed.normalization || !parsed.portabilityManifest) {
    throw new Error("Turso upload bundle is missing normalization evidence.");
  }
  if (parsed.retiredSchemaArchive !== null) {
    const archive = parsed.retiredSchemaArchive;
    if (
      !archive
      || archive.filename !== TURSO_UPLOAD_RETIRED_SCHEMA_ARCHIVE_FILENAME
      || archive.version !== "scalius-retired-schema-archive/v1"
      || archive.integrity !== "ok"
      || !Array.isArray(archive.tables)
    ) {
      throw new Error("Turso upload bundle has invalid retired schema archive evidence.");
    }
    requireNonNegativeSafeInteger(archive.bytes, "retiredSchemaArchive.bytes");
    requireSha256(archive.sha256, "retiredSchemaArchive.sha256");
    requireNonNegativeSafeInteger(
      archive.tableCount,
      "retiredSchemaArchive.tableCount",
    );
    requireNonNegativeSafeInteger(
      archive.rowCount,
      "retiredSchemaArchive.rowCount",
    );
    if (archive.tableCount !== archive.tables.length) {
      throw new Error("Retired schema archive table count differs from its evidence.");
    }
    for (const table of archive.tables) {
      if (typeof table.table !== "string" || !table.table) {
        throw new Error("Retired schema archive contains an invalid table name.");
      }
      requireNonNegativeSafeInteger(
        table.rowCount,
        `retiredSchemaArchive.tables.${table.table}.rowCount`,
      );
      requireSha256(
        table.contentSha256,
        `retiredSchemaArchive.tables.${table.table}.contentSha256`,
      );
    }
    const rowCount = archive.tables.reduce((sum, table) => sum + table.rowCount, 0);
    if (archive.rowCount !== rowCount) {
      throw new Error("Retired schema archive row count differs from its evidence.");
    }
  }

  return {
    bundlePath: resolvedBundlePath,
    databasePath: join(
      resolvedBundlePath,
      TURSO_UPLOAD_DATABASE_FILENAME,
    ),
    evidencePath,
    retiredSchemaArchivePath: parsed.retiredSchemaArchive
      ? join(resolvedBundlePath, TURSO_UPLOAD_RETIRED_SCHEMA_ARCHIVE_FILENAME)
      : null,
    evidence: parsed as TursoUploadBundleEvidence,
  };
}

export async function verifyTursoUploadBundleFiles(bundlePath: string): Promise<
  Awaited<ReturnType<typeof readTursoUploadBundle>>
> {
  const bundle = await readTursoUploadBundle(bundlePath);
  const artifactHash = await sha256File(bundle.databasePath);
  if (
    artifactHash.bytes !== bundle.evidence.artifact.bytes ||
    artifactHash.sha256 !== bundle.evidence.artifact.sha256
  ) {
    throw new Error("Turso upload database artifact does not match evidence.json.");
  }
  if (bundle.retiredSchemaArchivePath && bundle.evidence.retiredSchemaArchive) {
    const archiveHash = await sha256File(bundle.retiredSchemaArchivePath);
    if (
      archiveHash.bytes !== bundle.evidence.retiredSchemaArchive.bytes
      || archiveHash.sha256 !== bundle.evidence.retiredSchemaArchive.sha256
    ) {
      throw new Error("Retired schema archive does not match evidence.json.");
    }
    verifyRetiredSchemaArchiveContents(
      bundle.retiredSchemaArchivePath,
      bundle.evidence.retiredSchemaArchive,
    );
  }
  return bundle;
}
