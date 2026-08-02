import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  provisionAndUploadTursoBundle,
  TURSO_PLATFORM_UPLOAD_RECEIPT_FILENAME,
  TURSO_PROVISION_RECEIPT_FILENAME,
} from "../scripts/provision-and-upload-turso";
import {
  sha256File,
  TURSO_UPLOAD_BUNDLE_VERSION,
  TURSO_UPLOAD_DATABASE_FILENAME,
  TURSO_UPLOAD_EVIDENCE_FILENAME,
} from "../scripts/turso-upload-bundle";
import {
  preflightTursoUploadStorage,
  preflightTursoLoadBudget,
} from "../scripts/turso-platform-upload";
import {
  TURSO_UPLOAD_RECEIPT_VERSION,
  TURSO_UPLOAD_RECEIPT_FILENAME,
  type TursoUploadReceipt,
  type UploadTursoBundleOptions,
  type UploadTursoBundleSummary,
} from "../scripts/upload-turso-bundle";

const directories: string[] = [];
const digest = (character: string) => character.repeat(64);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scalius-platform-upload-test-"));
  directories.push(directory);
  return directory;
}

async function createBundle(): Promise<string> {
  const bundlePath = await temporaryDirectory();
  const databasePath = join(bundlePath, TURSO_UPLOAD_DATABASE_FILENAME);
  const artifact = Buffer.from("test-turso-mvcc-artifact");
  await writeFile(databasePath, artifact, { mode: 0o600 });
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  await writeFile(
    join(bundlePath, TURSO_UPLOAD_EVIDENCE_FILENAME),
    `${JSON.stringify({
      version: TURSO_UPLOAD_BUNDLE_VERSION,
      source: {
        filename: "source.sql",
        bytes: 100,
        sha256: digest("1"),
        portableExport: null,
      },
      artifact: {
        engine: "turso-mvcc",
        filename: TURSO_UPLOAD_DATABASE_FILENAME,
        bytes: artifact.length,
        sha256: artifactSha256,
        pragmas: {
          pageSize: 4096,
          journalMode: "mvcc",
          autoVacuum: 0,
          encoding: "UTF-8",
        },
      },
      normalization: {
        tableCount: 0,
        rowCount: 0,
        discardedColumns: [],
        ignoredSourceTables: [],
        normalizedValueCount: 0,
        foreignKeyViolations: 0,
        integrity: "ok",
      },
      retiredSchemaArchive: null,
      portabilityManifest: {
        version: "scalius-sqlite-portability/v2",
        chunkSize: 1_000,
        schemaDigest: digest("2"),
        tables: [],
        fingerprint: digest("3"),
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return bundlePath;
}

async function writeFakeUploadReceipt(
  options: UploadTursoBundleOptions,
): Promise<UploadTursoBundleSummary> {
  const receiptPath = options.receiptPath!;
  const hostname = new URL(options.databaseUrl).hostname;
  const artifact = await sha256File(
    join(options.bundlePath, TURSO_UPLOAD_DATABASE_FILENAME),
  );
  const receipt: TursoUploadReceipt = {
    version: TURSO_UPLOAD_RECEIPT_VERSION,
    databaseHostname: hostname,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    retiredSchemaArchiveSha256: null,
    sourceFingerprint: digest("3"),
    targetFingerprint: digest("3"),
    schemaDigest: digest("2"),
    tableCount: 0,
    rowCount: 0,
    journalMode: "mvcc",
    integrity: "ok",
    foreignKeyViolations: 0,
    uploadDisposition: "uploaded",
    uploadHttpStatus: 200,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    ...receipt,
    receiptPath,
    receiptSha256: (await sha256File(receiptPath)).sha256,
    resumedFromReceipt: false,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("Turso Platform upload orchestration", () => {
  it("provisions an MVCC upload target, verifies upload, rotates tokens, and resumes locally", async () => {
    const bundlePath = await createBundle();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/subscription")) {
        return Response.json({ subscription: { plan: "starter", overages: false } });
      }
      if (url.endsWith("/usage")) {
        return Response.json({ organization: { usage: { storage_bytes: 10 } } });
      }
      if (url.endsWith("/plans")) {
        return Response.json({ plans: [{ name: "starter", quotas: { storage: 1_000_000 } }] });
      }
      if (url.endsWith("/databases")) {
        return Response.json({
          database: {
            DbId: "database-id-1",
            Name: "merchant-migration-1",
            Hostname: "merchant-migration-1-example.aws-ap-south-1.turso.io",
          },
        });
      }
      if (url.includes("/auth/tokens?")) {
        return Response.json({ jwt: "temporary-database-token" });
      }
      if (url.endsWith("/auth/rotate")) {
        return new Response(null, { status: 200 });
      }
      return new Response("unexpected request", { status: 500 });
    });
    const uploadBundleImpl = vi.fn(writeFakeUploadReceipt);

    const first = await provisionAndUploadTursoBundle({
      bundlePath,
      organization: "example",
      group: "merchant-group",
      databaseName: "merchant-migration-1",
      platformToken: "platform-token-secret",
      fetchImpl,
      uploadBundleImpl,
    });

    expect(first.target.databaseId).toBe("database-id-1");
    expect(first.upload.targetFingerprint).toBe(digest("3"));
    expect(first.resumedFromFinalReceipt).toBe(false);
    expect(uploadBundleImpl).toHaveBeenCalledOnce();
    expect(uploadBundleImpl.mock.calls[0]![0].authToken)
      .toBe("temporary-database-token");
    expect(requests).toHaveLength(6);
    expect(JSON.parse(String(requests[3]!.init?.body))).toEqual({
      name: "merchant-migration-1",
      group: "merchant-group",
      seed: { type: "database_upload" },
      use_tursodb: true,
    });
    expect(requests[5]!.url).toMatch(/\/auth\/rotate$/);
    expect(first.storagePreflight).toMatchObject({
      plan: "starter",
      availableBytes: 999_990,
      requiresOverage: false,
    });

    const receiptText = await Promise.all([
      readFile(join(bundlePath, TURSO_PROVISION_RECEIPT_FILENAME), "utf8"),
      readFile(join(bundlePath, TURSO_PLATFORM_UPLOAD_RECEIPT_FILENAME), "utf8"),
    ]);
    expect(receiptText.join("\n")).not.toContain("platform-token-secret");
    expect(receiptText.join("\n")).not.toContain("temporary-database-token");

    fetchImpl.mockClear();
    uploadBundleImpl.mockClear();
    const resumed = await provisionAndUploadTursoBundle({
      bundlePath,
      organization: "example",
      group: "merchant-group",
      databaseName: "merchant-migration-1",
      platformToken: "different-valid-platform-token",
      fetchImpl,
      uploadBundleImpl,
    });
    expect(resumed.resumedFromFinalReceipt).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploadBundleImpl).not.toHaveBeenCalled();

    const uploadReceiptPath = join(bundlePath, TURSO_UPLOAD_RECEIPT_FILENAME);
    const alteredUploadReceipt = JSON.parse(
      await readFile(uploadReceiptPath, "utf8"),
    ) as TursoUploadReceipt;
    alteredUploadReceipt.rowCount += 1;
    await writeFile(
      uploadReceiptPath,
      `${JSON.stringify(alteredUploadReceipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(provisionAndUploadTursoBundle({
      bundlePath,
      organization: "example",
      group: "merchant-group",
      databaseName: "merchant-migration-1",
      platformToken: "different-valid-platform-token",
      fetchImpl,
      uploadBundleImpl,
    })).rejects.toThrow(/upload receipt does not match/i);
  });

  it("invalidates a temporary token and withholds final proof when upload fails", async () => {
    const bundlePath = await createBundle();
    const requests: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/subscription")) {
        return Response.json({ subscription: { plan: "starter", overages: false } });
      }
      if (url.endsWith("/usage")) {
        return Response.json({ organization: { usage: { storage_bytes: 0 } } });
      }
      if (url.endsWith("/plans")) {
        return Response.json({ plans: [{ name: "starter", quotas: { storage: 1_000_000 } }] });
      }
      if (url.endsWith("/databases")) {
        return Response.json({
          database: {
            DbId: "database-id-2",
            Name: "merchant-migration-2",
            Hostname: "merchant-migration-2-example.aws-ap-south-1.turso.io",
          },
        });
      }
      if (url.includes("/auth/tokens?")) {
        return Response.json({ jwt: "temporary-database-token" });
      }
      if (url.endsWith("/auth/rotate")) {
        return new Response(null, { status: 200 });
      }
      return new Response("unexpected request", { status: 500 });
    });

    await expect(provisionAndUploadTursoBundle({
      bundlePath,
      organization: "example",
      group: "merchant-group",
      databaseName: "merchant-migration-2",
      platformToken: "platform-token-secret",
      fetchImpl,
      uploadBundleImpl: vi.fn(async () => {
        throw new Error("injected upload failure");
      }),
    })).rejects.toThrow(/injected upload failure/);

    expect(requests.at(-1)).toMatch(/\/auth\/rotate$/);
    await expect(readFile(
      join(bundlePath, TURSO_PLATFORM_UPLOAD_RECEIPT_FILENAME),
      "utf8",
    )).rejects.toThrow();
  });

  it("refuses an artifact that cannot fit before provisioning a database", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/subscription")) {
        return Response.json({ subscription: { plan: "starter", overages: false } });
      }
      if (url.endsWith("/usage")) {
        return Response.json({ organization: { usage: { storage_bytes: 400 } } });
      }
      if (url.endsWith("/plans")) {
        return Response.json({ plans: [{ name: "starter", quotas: { storage: 1_000 } }] });
      }
      return new Response("database provisioning must not be called", { status: 500 });
    });

    await expect(preflightTursoUploadStorage({
      organization: "example",
      platformToken: "platform-token-secret",
      artifactBytes: 700,
      fetchImpl,
    })).rejects.toThrow(/exceed 600 available bytes/);

    expect(requests).toHaveLength(3);
    expect(requests).not.toContain(expect.stringMatching(/\/databases$/));
  });

  it("refuses a load run that cannot fit the remaining organization row quotas", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/subscription")) {
        return Response.json({ subscription: { plan: "starter", overages: false } });
      }
      if (url.endsWith("/usage")) {
        return Response.json({
          organization: { usage: { rows_read: 755, rows_written: 20 } },
        });
      }
      if (url.endsWith("/plans")) {
        return Response.json({
          plans: [{
            name: "starter",
            quotas: { rowsRead: 500, rowsWritten: 1_000 },
          }],
        });
      }
      return new Response("unexpected request", { status: 500 });
    });

    await expect(preflightTursoLoadBudget({
      organization: "capacity-tests",
      platformToken: "platform-token-secret",
      rowsReadBudget: 100,
      rowsWrittenBudget: 50,
      fetchImpl,
    })).rejects.toThrow(/only 0 reads and 980 writes remain/);
  });

  it("reports a bounded non-billable load budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/subscription")) {
        return Response.json({ subscription: { plan: "scaler", overages: false } });
      }
      if (url.endsWith("/usage")) {
        return Response.json({
          organization: { usage: { rows_read: 1_000, rows_written: 200 } },
        });
      }
      if (url.endsWith("/plans")) {
        return Response.json({
          plans: [{
            name: "scaler",
            quotas: { rowsRead: 10_000, rowsWritten: 2_000 },
          }],
        });
      }
      return new Response("unexpected request", { status: 500 });
    });

    await expect(preflightTursoLoadBudget({
      organization: "capacity-tests",
      platformToken: "platform-token-secret",
      rowsReadBudget: 2_000,
      rowsWrittenBudget: 500,
      fetchImpl,
    })).resolves.toMatchObject({
      plan: "scaler",
      rowsReadAvailable: 9_000,
      rowsWrittenAvailable: 1_800,
      requiresOverage: false,
    });
  });
});
