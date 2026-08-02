import { createReadStream } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createSqlitePortabilityManifest,
  createTursoPortabilityExecutor,
  verifySqlitePortabilityManifests,
} from "../src/portability";
import {
  sha256File,
  TURSO_UPLOAD_EVIDENCE_FILENAME,
  verifyTursoUploadBundleFiles,
} from "./turso-upload-bundle";

export const TURSO_UPLOAD_RECEIPT_VERSION =
  "scalius-turso-upload-receipt/v3" as const;
export const TURSO_UPLOAD_RECEIPT_FILENAME = "upload-receipt.json";

export interface UploadTursoBundleOptions {
  bundlePath: string;
  databaseUrl: string;
  authToken: string;
  receiptPath?: string;
  expectedJournalMode?: string;
  onProgress?: (progress: {
    table: string;
    rowsRead: number;
    chunksRead: number;
  }) => void;
}

export interface TursoUploadReceipt {
  version: typeof TURSO_UPLOAD_RECEIPT_VERSION;
  databaseHostname: string;
  artifactSha256: string;
  artifactBytes: number;
  retiredSchemaArchiveSha256: string | null;
  sourceFingerprint: string;
  targetFingerprint: string;
  schemaDigest: string;
  tableCount: number;
  rowCount: number;
  journalMode: string;
  integrity: "ok";
  foreignKeyViolations: 0;
  uploadDisposition: "uploaded" | "verified_after_upload_error";
  uploadHttpStatus: number | null;
}

export interface UploadTursoBundleSummary extends TursoUploadReceipt {
  receiptPath: string;
  receiptSha256: string;
  resumedFromReceipt: boolean;
}

export interface TursoUploadReceiptExpectation {
  databaseHostname: string;
  artifactSha256: string;
  artifactBytes: number;
  retiredSchemaArchiveSha256: string | null;
  sourceFingerprint: string;
  schemaDigest: string;
  tableCount: number;
  rowCount: number;
  journalMode: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseArguments(argv: readonly string[]): UploadTursoBundleOptions {
  let bundlePath: string | undefined;
  let databaseUrl = process.env.TURSO_DATABASE_URL?.trim();
  let receiptPath: string | undefined;
  let expectedJournalMode = "mvcc";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--bundle") bundlePath = argv[++index];
    else if (argument === "--database-url") databaseUrl = argv[++index];
    else if (argument === "--receipt") receiptPath = argv[++index];
    else if (argument === "--expected-journal-mode") {
      expectedJournalMode = argv[++index] ?? "";
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
    }
  }
  if (!bundlePath?.trim()) throw new Error("--bundle is required.");
  if (!databaseUrl?.trim()) {
    throw new Error("--database-url or TURSO_DATABASE_URL is required.");
  }
  if (!expectedJournalMode.trim()) {
    throw new Error("--expected-journal-mode must not be empty.");
  }
  return {
    bundlePath: resolve(bundlePath),
    databaseUrl,
    authToken: requiredEnvironment("TURSO_AUTH_TOKEN"),
    receiptPath: receiptPath ? resolve(receiptPath) : undefined,
    expectedJournalMode,
    onProgress(progress) {
      if (progress.rowsRead % 100_000 === 0) {
        process.stderr.write(
          `[turso-upload] verified ${progress.table}: ${progress.rowsRead} rows\n`,
        );
      }
    },
  };
}

function normalizeDatabaseUrl(value: string): {
  connectionUrl: string;
  hostname: string;
  uploadUrl: string;
} {
  const parsed = new URL(value);
  if (!parsed.hostname || (parsed.protocol !== "https:" && parsed.protocol !== "turso:")) {
    throw new Error("Turso database URL must use credential-free https:// or turso://.");
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Turso database URL must not contain credentials, a path, query, or fragment.");
  }
  return {
    connectionUrl: `https://${parsed.hostname}`,
    hostname: parsed.hostname.toLowerCase(),
    uploadUrl: `https://${parsed.hostname}/v1/upload`,
  };
}

function firstScalar(rows: readonly Record<string, unknown>[]): unknown {
  const first = rows[0];
  return first ? Object.values(first)[0] : undefined;
}

async function verifyRemoteTarget(input: {
  databaseUrl: string;
  authToken: string;
  sourceManifest: Awaited<ReturnType<typeof createSqlitePortabilityManifest>>;
  expectedJournalMode: string;
  onProgress?: UploadTursoBundleOptions["onProgress"];
}): Promise<Omit<TursoUploadReceipt,
  | "version"
  | "databaseHostname"
  | "artifactSha256"
  | "artifactBytes"
  | "retiredSchemaArchiveSha256"
  | "sourceFingerprint"
  | "uploadDisposition"
  | "uploadHttpStatus"
>> {
  const executor = createTursoPortabilityExecutor({
    url: input.databaseUrl,
    authToken: input.authToken,
  });
  try {
    const [journalRows, integrityRows, foreignKeyRows] = await Promise.all([
      executor.query("PRAGMA journal_mode"),
      executor.query("PRAGMA integrity_check"),
      executor.query("PRAGMA foreign_key_check"),
    ]);
    const journalMode = String(firstScalar(journalRows) ?? "").toLowerCase();
    const integrity = String(firstScalar(integrityRows) ?? "").toLowerCase();
    if (journalMode !== input.expectedJournalMode.toLowerCase()) {
      throw new Error(
        `Target journal mode ${journalMode || "empty"} does not prove the expected ${input.expectedJournalMode} engine.`,
      );
    }
    if (integrity !== "ok") {
      throw new Error(`Target integrity_check returned ${integrity || "empty"}.`);
    }
    if (foreignKeyRows.length > 0) {
      throw new Error(
        `Target contains ${foreignKeyRows.length} foreign-key violations.`,
      );
    }

    const targetManifest = await createSqlitePortabilityManifest(executor, {
      chunkSize: input.sourceManifest.chunkSize,
      onProgress: input.onProgress,
    });
    const comparison = verifySqlitePortabilityManifests(
      input.sourceManifest,
      targetManifest,
    );
    if (!comparison.ok) {
      throw new Error(
        `Target portability verification failed: ${comparison.issues.join(" ")}`,
      );
    }
    const rowCount = targetManifest.tables.reduce(
      (total, table) => total + table.rowCount,
      0,
    );
    return {
      targetFingerprint: targetManifest.fingerprint,
      schemaDigest: targetManifest.schemaDigest,
      tableCount: targetManifest.tables.length,
      rowCount,
      journalMode,
      integrity: "ok",
      foreignKeyViolations: 0,
    };
  } finally {
    await executor.close?.();
  }
}

async function uploadDatabaseFile(input: {
  uploadUrl: string;
  authToken: string;
  databasePath: string;
  bytes: number;
}): Promise<number> {
  const response = await fetch(input.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.authToken}`,
      "Content-Length": String(input.bytes),
      "Content-Type": "application/octet-stream",
    },
    body: createReadStream(input.databasePath),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) {
    const providerMessage = (await response.text()).slice(0, 1_000).trim();
    throw new Error(
      `Turso upload returned HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : "."}`,
    );
  }
  return response.status;
}

export async function readExistingTursoUploadReceipt(
  path: string,
  expected: TursoUploadReceiptExpectation,
): Promise<UploadTursoBundleSummary | undefined> {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  const receipt = JSON.parse(await readFile(path, "utf8")) as TursoUploadReceipt;
  if (
    receipt.version !== TURSO_UPLOAD_RECEIPT_VERSION ||
    receipt.databaseHostname !== expected.databaseHostname ||
    receipt.artifactSha256 !== expected.artifactSha256 ||
    receipt.artifactBytes !== expected.artifactBytes ||
    receipt.retiredSchemaArchiveSha256 !== expected.retiredSchemaArchiveSha256 ||
    receipt.sourceFingerprint !== expected.sourceFingerprint ||
    receipt.targetFingerprint !== receipt.sourceFingerprint ||
    receipt.schemaDigest !== expected.schemaDigest ||
    receipt.tableCount !== expected.tableCount ||
    receipt.rowCount !== expected.rowCount ||
    receipt.journalMode !== expected.journalMode.toLowerCase() ||
    receipt.integrity !== "ok" ||
    receipt.foreignKeyViolations !== 0 ||
    !(
      (receipt.uploadDisposition === "uploaded" &&
        Number.isSafeInteger(receipt.uploadHttpStatus) &&
        Number(receipt.uploadHttpStatus) >= 200 &&
        Number(receipt.uploadHttpStatus) < 300) ||
      (receipt.uploadDisposition === "verified_after_upload_error" &&
        receipt.uploadHttpStatus === null)
    )
  ) {
    throw new Error("Existing Turso upload receipt does not match this migration.");
  }
  return {
    ...receipt,
    receiptPath: path,
    receiptSha256: (await sha256File(path)).sha256,
    resumedFromReceipt: true,
  };
}

export async function uploadTursoBundle(
  options: UploadTursoBundleOptions,
): Promise<UploadTursoBundleSummary> {
  const bundle = await verifyTursoUploadBundleFiles(options.bundlePath);
  const expectedJournalMode = (options.expectedJournalMode ?? "mvcc").toLowerCase();
  if (bundle.evidence.artifact.pragmas.journalMode !== expectedJournalMode) {
    throw new Error(
      `Upload bundle journal mode ${bundle.evidence.artifact.pragmas.journalMode} does not match expected ${expectedJournalMode}.`,
    );
  }
  const target = normalizeDatabaseUrl(options.databaseUrl);
  const receiptPath = resolve(
    options.receiptPath ?? join(bundle.bundlePath, TURSO_UPLOAD_RECEIPT_FILENAME),
  );
  if (receiptPath === bundle.evidencePath) {
    throw new Error(`Receipt must not overwrite ${TURSO_UPLOAD_EVIDENCE_FILENAME}.`);
  }
  const existingReceipt = await readExistingTursoUploadReceipt(receiptPath, {
    databaseHostname: target.hostname,
    artifactSha256: bundle.evidence.artifact.sha256,
    artifactBytes: bundle.evidence.artifact.bytes,
    retiredSchemaArchiveSha256:
      bundle.evidence.retiredSchemaArchive?.sha256 ?? null,
    sourceFingerprint: bundle.evidence.portabilityManifest.fingerprint,
    schemaDigest: bundle.evidence.portabilityManifest.schemaDigest,
    tableCount: bundle.evidence.portabilityManifest.tables.length,
    rowCount: bundle.evidence.portabilityManifest.tables.reduce(
      (total, table) => total + table.rowCount,
      0,
    ),
    journalMode: expectedJournalMode,
  });
  if (existingReceipt) return existingReceipt;

  let uploadHttpStatus: number | null = null;
  let uploadDisposition: TursoUploadReceipt["uploadDisposition"] = "uploaded";
  let uploadError: unknown;
  try {
    uploadHttpStatus = await uploadDatabaseFile({
      uploadUrl: target.uploadUrl,
      authToken: options.authToken,
      databasePath: bundle.databasePath,
      bytes: bundle.evidence.artifact.bytes,
    });
  } catch (error) {
    uploadError = error;
    uploadDisposition = "verified_after_upload_error";
  }

  let verification;
  try {
    verification = await verifyRemoteTarget({
      databaseUrl: target.connectionUrl,
      authToken: options.authToken,
      sourceManifest: bundle.evidence.portabilityManifest,
      expectedJournalMode,
      onProgress: options.onProgress,
    });
  } catch (verificationError) {
    if (uploadError instanceof Error) {
      throw new AggregateError(
        [uploadError, verificationError],
        "Turso upload failed and the target could not be verified as an already-completed upload.",
      );
    }
    throw verificationError;
  }

  const receipt: TursoUploadReceipt = {
    version: TURSO_UPLOAD_RECEIPT_VERSION,
    databaseHostname: target.hostname,
    artifactSha256: bundle.evidence.artifact.sha256,
    artifactBytes: bundle.evidence.artifact.bytes,
    retiredSchemaArchiveSha256:
      bundle.evidence.retiredSchemaArchive?.sha256 ?? null,
    sourceFingerprint: bundle.evidence.portabilityManifest.fingerprint,
    ...verification,
    uploadDisposition,
    uploadHttpStatus,
  };
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return {
    ...receipt,
    receiptPath,
    receiptSha256: (await sha256File(receiptPath)).sha256,
    resumedFromReceipt: false,
  };
}

async function main(): Promise<void> {
  const summary = await uploadTursoBundle(
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
