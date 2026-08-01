import { access, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  invalidateTursoDatabaseTokens,
  mintTursoUploadToken,
  preflightTursoUploadStorage,
  provisionTursoUploadTarget,
  type TursoStoragePreflight,
  type TursoUploadTarget,
} from "./turso-platform-upload";
import {
  sha256File,
  verifyTursoUploadBundleFiles,
} from "./turso-upload-bundle";
import {
  readExistingTursoUploadReceipt,
  TURSO_UPLOAD_RECEIPT_FILENAME,
  uploadTursoBundle,
  type TursoUploadReceiptExpectation,
  type UploadTursoBundleSummary,
} from "./upload-turso-bundle";

export const TURSO_PROVISION_RECEIPT_VERSION =
  "scalius-turso-provision-receipt/v2" as const;
export const TURSO_PLATFORM_UPLOAD_RECEIPT_VERSION =
  "scalius-turso-platform-upload-receipt/v2" as const;
export const TURSO_PROVISION_RECEIPT_FILENAME = "provision-receipt.json";
export const TURSO_PLATFORM_UPLOAD_RECEIPT_FILENAME =
  "platform-upload-receipt.json";

export interface TursoProvisionReceipt extends TursoUploadTarget {
  version: typeof TURSO_PROVISION_RECEIPT_VERSION;
  organization: string;
  group: string;
  seedType: "database_upload";
  engine: "turso-mvcc";
  artifactBytes: number;
  artifactSha256: string;
  sourceFingerprint: string;
}

export interface TursoPlatformUploadReceipt {
  version: typeof TURSO_PLATFORM_UPLOAD_RECEIPT_VERSION;
  organization: string;
  group: string;
  databaseId: string;
  databaseName: string;
  hostname: string;
  artifactSha256: string;
  sourceFingerprint: string;
  targetFingerprint: string;
  provisionReceiptSha256: string;
  uploadReceiptSha256: string;
  uploadTokensInvalidated: true;
  storagePreflight: TursoStoragePreflight;
}

export interface ProvisionAndUploadTursoOptions {
  bundlePath: string;
  organization: string;
  group: string;
  databaseName: string;
  platformToken: string;
  provisionReceiptPath?: string;
  uploadReceiptPath?: string;
  finalReceiptPath?: string;
  allowStorageOverage?: boolean;
  fetchImpl?: typeof fetch;
  uploadBundleImpl?: typeof uploadTursoBundle;
}

export interface ProvisionAndUploadTursoSummary {
  target: TursoUploadTarget;
  upload: UploadTursoBundleSummary;
  provisionReceiptPath: string;
  provisionReceiptSha256: string;
  finalReceiptPath: string;
  finalReceiptSha256: string;
  storagePreflight: TursoStoragePreflight;
  resumedFromProvisionReceipt: boolean;
  resumedFromFinalReceipt: boolean;
}

function normalizedIdentity(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writePrivateJson(path: string, value: object): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateProvisionReceipt(
  value: unknown,
  expected: {
    organization: string;
    group: string;
    databaseName: string;
    artifactBytes: number;
    artifactSha256: string;
    sourceFingerprint: string;
  },
): TursoProvisionReceipt {
  const receipt = value as Partial<TursoProvisionReceipt>;
  if (
    receipt.version !== TURSO_PROVISION_RECEIPT_VERSION ||
    receipt.organization !== expected.organization ||
    receipt.group !== expected.group ||
    receipt.databaseName !== expected.databaseName ||
    receipt.artifactBytes !== expected.artifactBytes ||
    receipt.artifactSha256 !== expected.artifactSha256 ||
    receipt.sourceFingerprint !== expected.sourceFingerprint ||
    receipt.seedType !== "database_upload" ||
    receipt.engine !== "turso-mvcc" ||
    !receipt.databaseId ||
    !receipt.hostname ||
    receipt.databaseUrl !== `https://${receipt.hostname}`
  ) {
    throw new Error("Existing Turso provision receipt does not match this migration.");
  }
  return receipt as TursoProvisionReceipt;
}

function expectedUploadReceipt(
  bundle: Awaited<ReturnType<typeof verifyTursoUploadBundleFiles>>,
  databaseHostname: string,
): TursoUploadReceiptExpectation {
  return {
    databaseHostname,
    artifactSha256: bundle.evidence.artifact.sha256,
    artifactBytes: bundle.evidence.artifact.bytes,
    sourceFingerprint: bundle.evidence.portabilityManifest.fingerprint,
    schemaDigest: bundle.evidence.portabilityManifest.schemaDigest,
    tableCount: bundle.evidence.portabilityManifest.tables.length,
    rowCount: bundle.evidence.portabilityManifest.tables.reduce(
      (total, table) => total + table.rowCount,
      0,
    ),
    journalMode: "mvcc",
  };
}

async function readProvisionReceipt(
  path: string,
  expected: Parameters<typeof validateProvisionReceipt>[1],
): Promise<TursoProvisionReceipt | undefined> {
  if (!(await exists(path))) return undefined;
  return validateProvisionReceipt(
    JSON.parse(await readFile(path, "utf8")),
    expected,
  );
}

async function readFinalReceipt(
  path: string,
  expected: {
    organization: string;
    group: string;
    databaseName: string;
    artifactBytes: number;
    artifactSha256: string;
    sourceFingerprint: string;
  },
): Promise<TursoPlatformUploadReceipt | undefined> {
  if (!(await exists(path))) return undefined;
  const receipt = JSON.parse(
    await readFile(path, "utf8"),
  ) as Partial<TursoPlatformUploadReceipt>;
  const storage = receipt.storagePreflight;
  if (
    receipt.version !== TURSO_PLATFORM_UPLOAD_RECEIPT_VERSION ||
    receipt.organization !== expected.organization ||
    receipt.group !== expected.group ||
    receipt.databaseName !== expected.databaseName ||
    receipt.artifactSha256 !== expected.artifactSha256 ||
    receipt.sourceFingerprint !== expected.sourceFingerprint ||
    receipt.targetFingerprint !== expected.sourceFingerprint ||
    receipt.uploadTokensInvalidated !== true ||
    !receipt.databaseId ||
    !receipt.hostname ||
    !receipt.provisionReceiptSha256 ||
    !receipt.uploadReceiptSha256 ||
    !storage ||
    storage.organization !== expected.organization ||
    storage.artifactBytes !== expected.artifactBytes ||
    !storage.plan ||
    typeof storage.overagesEnabled !== "boolean" ||
    typeof storage.requiresOverage !== "boolean" ||
    !Number.isSafeInteger(storage.quotaBytes) ||
    storage.quotaBytes < 0 ||
    !Number.isSafeInteger(storage.usedBytes) ||
    storage.usedBytes < 0 ||
    !Number.isSafeInteger(storage.availableBytes) ||
    storage.availableBytes < 0 ||
    storage.availableBytes !== Math.max(0, storage.quotaBytes - storage.usedBytes) ||
    storage.requiresOverage !== (storage.artifactBytes > storage.availableBytes) ||
    (storage.requiresOverage && !storage.overagesEnabled)
  ) {
    throw new Error("Existing Turso platform upload receipt does not match this migration.");
  }
  return receipt as TursoPlatformUploadReceipt;
}

function parseArguments(argv: readonly string[]): Omit<
  ProvisionAndUploadTursoOptions,
  "platformToken"
> {
  let bundlePath: string | undefined;
  let organization: string | undefined;
  let group: string | undefined;
  let databaseName: string | undefined;
  let allowStorageOverage = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--bundle") bundlePath = argv[++index];
    else if (argument === "--organization") organization = argv[++index];
    else if (argument === "--group") group = argv[++index];
    else if (argument === "--database") databaseName = argv[++index];
    else if (argument === "--allow-storage-overage") allowStorageOverage = true;
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!bundlePath?.trim()) throw new Error("--bundle is required.");
  if (!organization?.trim()) throw new Error("--organization is required.");
  if (!group?.trim()) throw new Error("--group is required.");
  if (!databaseName?.trim()) throw new Error("--database is required.");
  return {
    bundlePath: resolve(bundlePath),
    organization,
    group,
    databaseName,
    allowStorageOverage,
  };
}

export async function provisionAndUploadTursoBundle(
  options: ProvisionAndUploadTursoOptions,
): Promise<ProvisionAndUploadTursoSummary> {
  const bundle = await verifyTursoUploadBundleFiles(options.bundlePath);
  const organization = normalizedIdentity(options.organization, "organization");
  const group = normalizedIdentity(options.group, "group");
  const databaseName = normalizedIdentity(options.databaseName, "databaseName");
  const expected = {
    organization,
    group,
    databaseName,
    artifactBytes: bundle.evidence.artifact.bytes,
    artifactSha256: bundle.evidence.artifact.sha256,
    sourceFingerprint: bundle.evidence.portabilityManifest.fingerprint,
  };
  const provisionReceiptPath = resolve(
    options.provisionReceiptPath
      ?? join(bundle.bundlePath, TURSO_PROVISION_RECEIPT_FILENAME),
  );
  const uploadReceiptPath = resolve(
    options.uploadReceiptPath
      ?? join(bundle.bundlePath, TURSO_UPLOAD_RECEIPT_FILENAME),
  );
  const finalReceiptPath = resolve(
    options.finalReceiptPath
      ?? join(bundle.bundlePath, TURSO_PLATFORM_UPLOAD_RECEIPT_FILENAME),
  );

  const existingFinal = await readFinalReceipt(finalReceiptPath, expected);
  if (existingFinal) {
    const provision = await readProvisionReceipt(provisionReceiptPath, expected);
    if (!provision) {
      throw new Error("Final Turso receipt exists without its provision receipt.");
    }
    const provisionReceiptSha256 = (await sha256File(provisionReceiptPath)).sha256;
    if (
      provision.databaseId !== existingFinal.databaseId ||
      provision.hostname !== existingFinal.hostname ||
      provisionReceiptSha256 !== existingFinal.provisionReceiptSha256
    ) {
      throw new Error("Final Turso receipt does not match its provision receipt.");
    }
    const upload = await readExistingTursoUploadReceipt(
      uploadReceiptPath,
      expectedUploadReceipt(bundle, existingFinal.hostname),
    );
    if (!upload) {
      throw new Error("Final Turso receipt exists without its upload receipt.");
    }
    if (upload.receiptSha256 !== existingFinal.uploadReceiptSha256) {
      throw new Error("Final Turso receipt does not match its upload receipt.");
    }
    return {
      target: provision,
      upload,
      provisionReceiptPath,
      provisionReceiptSha256,
      finalReceiptPath,
      finalReceiptSha256: (await sha256File(finalReceiptPath)).sha256,
      storagePreflight: existingFinal.storagePreflight,
      resumedFromProvisionReceipt: true,
      resumedFromFinalReceipt: true,
    };
  }

  const storagePreflight = await preflightTursoUploadStorage({
    organization,
    platformToken: options.platformToken,
    artifactBytes: bundle.evidence.artifact.bytes,
    allowStorageOverage: options.allowStorageOverage,
    fetchImpl: options.fetchImpl,
  });

  let provision = await readProvisionReceipt(provisionReceiptPath, expected);
  const resumedFromProvisionReceipt = provision !== undefined;
  if (!provision) {
    const target = await provisionTursoUploadTarget({
      organization,
      group,
      databaseName,
      platformToken: options.platformToken,
      fetchImpl: options.fetchImpl,
    });
    provision = {
      version: TURSO_PROVISION_RECEIPT_VERSION,
      organization,
      group,
      ...target,
      seedType: "database_upload",
      engine: "turso-mvcc",
      artifactBytes: expected.artifactBytes,
      artifactSha256: expected.artifactSha256,
      sourceFingerprint: expected.sourceFingerprint,
    };
    await writePrivateJson(provisionReceiptPath, provision);
  }
  const provisionReceiptSha256 = (await sha256File(provisionReceiptPath)).sha256;

  let upload = await readExistingTursoUploadReceipt(
    uploadReceiptPath,
    expectedUploadReceipt(bundle, provision.hostname),
  );
  const platformOptions = {
    organization,
    databaseName,
    platformToken: options.platformToken,
    fetchImpl: options.fetchImpl,
  };
  if (!upload) {
    if (resumedFromProvisionReceipt) {
      await invalidateTursoDatabaseTokens(platformOptions);
    }
    const authToken = await mintTursoUploadToken(platformOptions);
    let uploadError: unknown;
    let invalidationError: unknown;
    try {
      upload = await (options.uploadBundleImpl ?? uploadTursoBundle)({
        bundlePath: bundle.bundlePath,
        databaseUrl: provision.databaseUrl,
        authToken,
        receiptPath: uploadReceiptPath,
        expectedJournalMode: "mvcc",
      });
    } catch (error) {
      uploadError = error;
    } finally {
      try {
        await invalidateTursoDatabaseTokens(platformOptions);
      } catch (error) {
        invalidationError = error;
      }
    }
    if (uploadError && invalidationError) {
      throw new AggregateError(
        [uploadError, invalidationError],
        "Turso upload failed and its temporary database tokens could not be invalidated.",
      );
    }
    if (uploadError) throw uploadError;
    if (invalidationError) throw invalidationError;
  } else {
    // A crash can happen after the verified upload receipt but before token
    // invalidation/finalization. Rotating here makes that retry deterministic.
    await invalidateTursoDatabaseTokens(platformOptions);
  }
  if (!upload) throw new Error("Turso upload completed without a receipt.");

  const finalReceipt: TursoPlatformUploadReceipt = {
    version: TURSO_PLATFORM_UPLOAD_RECEIPT_VERSION,
    organization,
    group,
    databaseId: provision.databaseId,
    databaseName,
    hostname: provision.hostname,
    artifactSha256: expected.artifactSha256,
    sourceFingerprint: expected.sourceFingerprint,
    targetFingerprint: upload.targetFingerprint,
    provisionReceiptSha256,
    uploadReceiptSha256: upload.receiptSha256,
    uploadTokensInvalidated: true,
    storagePreflight,
  };
  await writePrivateJson(finalReceiptPath, finalReceipt);

  return {
    target: provision,
    upload,
    provisionReceiptPath,
    provisionReceiptSha256,
    finalReceiptPath,
    finalReceiptSha256: (await sha256File(finalReceiptPath)).sha256,
    storagePreflight,
    resumedFromProvisionReceipt,
    resumedFromFinalReceipt: false,
  };
}

async function main(): Promise<void> {
  const summary = await provisionAndUploadTursoBundle({
    ...parseArguments(process.argv.slice(2)),
    platformToken: requiredEnvironment("TURSO_PLATFORM_API_TOKEN"),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
