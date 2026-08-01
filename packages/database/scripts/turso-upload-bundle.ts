import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { SqlitePortabilityManifest } from "../src/portability";
import type {
  IgnoredSourceTable,
  TursoUploadPragmas,
} from "./normalize-d1-export-core";

export const TURSO_UPLOAD_BUNDLE_VERSION =
  "scalius-turso-upload-bundle/v2" as const;
// Turso's embedded MVCC implementation derives `database.db-log` from this
// exact suffix. A `.sqlite3` filename currently produces a mismatched log
// path during `PRAGMA journal_mode=mvcc`, so keep the portable artifact on the
// provider's supported `.db` path shape.
export const TURSO_UPLOAD_DATABASE_FILENAME = "database.db";
export const TURSO_UPLOAD_EVIDENCE_FILENAME = "evidence.json";

export interface TursoUploadBundleEvidence {
  version: typeof TURSO_UPLOAD_BUNDLE_VERSION;
  source: {
    filename: string;
    bytes: number;
    sha256: string;
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
  requireNonNegativeSafeInteger(parsed.artifact.bytes, "artifact.bytes");
  requireSha256(parsed.artifact.sha256, "artifact.sha256");
  if (!parsed.normalization || !parsed.portabilityManifest) {
    throw new Error("Turso upload bundle is missing normalization evidence.");
  }

  return {
    bundlePath: resolvedBundlePath,
    databasePath: join(
      resolvedBundlePath,
      TURSO_UPLOAD_DATABASE_FILENAME,
    ),
    evidencePath,
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
  return bundle;
}
