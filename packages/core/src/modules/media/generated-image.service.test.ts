import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeBatch: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  isAmbiguousStorageWriteError: vi.fn(
    (error: unknown) =>
      error instanceof Error && error.name === "AmbiguousStorageWriteError",
  ),
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/database/client")>()),
  safeBatch: mocks.safeBatch,
}));

vi.mock("../../integrations/storage", () => ({
  uploadFile: mocks.uploadFile,
  deleteFile: mocks.deleteFile,
  isAmbiguousStorageWriteError: mocks.isAmbiguousStorageWriteError,
  extractKeyFromUrl: (url: string) => new URL(url).pathname.replace(/^\//, ""),
}));

import {
  cleanupExpiredGeneratedImagePreviews,
  recordGeneratedImagePreview,
  saveGeneratedImagePreview,
  sha256Hex,
} from "./generated-image.service";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

function recordDb(count = 0) {
  let inserted: Record<string, unknown> | undefined;
  const db = {
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count }]),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        inserted = value;
        return [];
      }),
    })),
  };
  return { db, inserted: () => inserted };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    id: "aig_abcdefghijklmnop",
    userId: "admin_1",
    imageSha256: "",
    promptSha256: "a".repeat(64),
    provider: "cloudflare",
    model: "@cf/black-forest-labs/flux-2-dev",
    mimeType: "image/png",
    size: BYTES.byteLength,
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 12,
    costUsdMicros: null,
    costStatus: "not_reported",
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    retentionExpiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000),
    claimedAt: null,
    claimToken: null,
    consumedAt: null,
    consumedMediaId: null,
    r2Key: null,
    ...overrides,
  };
}

function saveDb(
  selectResults: Array<
    unknown[] | ((claimToken: string | null) => unknown[])
  >,
  claimRows: unknown[] = [{ id: "claim" }],
) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const updateSetValues: Array<Record<string, unknown>> = [];
  let activeClaimToken: string | null = null;
  let updateCount = 0;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          const result = selectResults.shift() ?? [];
          return typeof result === "function"
            ? result(activeClaimToken)
            : result;
        }),
      })),
    })),
    update: vi.fn(() => {
      updateCount += 1;
      const current = updateCount;
      return {
        set: vi.fn((setValue: Record<string, unknown>) => {
          updateSetValues.push(setValue);
          if (typeof setValue.claimToken === "string") {
            activeClaimToken = setValue.claimToken;
          }
          const whereResult = {
            returning: vi.fn(() => {
              if (current === 1) {
                return Promise.resolve(
                  claimRows.length === 0
                    ? []
                    : [{ id: "claim", claimToken: setValue.claimToken }],
                );
              }
              if (current === 2) return Promise.resolve([{ id: "claim" }]);
              return { kind: "update" };
            }),
            then: (resolve: (value: unknown[]) => void) => resolve([]),
          };
          return { where: vi.fn(() => whereResult) };
        }),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertedValues.push(value);
        return { returning: vi.fn(() => ({ kind: "insert" })) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ kind: "delete" })) })),
  };
  return { db, insertedValues, updateSetValues };
}

describe("generated media authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores only image/prompt hashes and bounded safe usage for a preview", async () => {
    const { db, inserted } = recordDb();
    const prompt = "Premium studio shoe photograph";

    const authority = await recordGeneratedImagePreview(db as never, {
      userId: "admin_1",
      provider: "cloudflare",
      model: "@cf/black-forest-labs/flux-2-dev",
      prompt,
      bytes: BYTES,
      mediaType: "image/png",
      usage: { inputTokens: 4.4, outputTokens: -3, totalTokens: 2_000_000_000 },
      now: NOW,
    });

    expect(authority).toMatchObject({
      provider: "cloudflare",
      usage: { inputTokens: 4, outputTokens: undefined, totalTokens: 1_000_000_000 },
      cost: { status: "not_reported" },
    });
    expect(inserted()).toMatchObject({
      userId: "admin_1",
      promptSha256: await sha256Hex(prompt),
      imageSha256: await sha256Hex(BYTES),
      inputTokens: 4,
      outputTokens: null,
      totalTokens: 1_000_000_000,
      costUsdMicros: null,
    });
    expect(JSON.stringify(inserted())).not.toContain(prompt);
  });

  it("cleans settled orphan keys after retention but never deletes consumed media", async () => {
    const bucket = { id: "scheduled-bucket" } as unknown as R2Bucket;
    const rows = [
      { id: "consumed", r2Key: "generated/consumed.png", consumedAt: NOW },
      { id: "orphan", r2Key: "generated/orphan.png", consumedAt: null },
      { id: "no-key", r2Key: null, consumedAt: null },
      { id: "retry-later", r2Key: "generated/retry.png", consumedAt: null },
    ];
    const returning = vi.fn().mockResolvedValue([
      { id: "consumed" },
      { id: "orphan" },
      { id: "no-key" },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({ returning })),
      })),
    };
    mocks.deleteFile.mockImplementation(async (key: string) => {
      if (key.endsWith("retry.png")) throw new Error("R2 unavailable");
    });

    await expect(
      cleanupExpiredGeneratedImagePreviews(db as never, NOW, bucket),
    ).resolves.toBe(3);
    expect(mocks.deleteFile).toHaveBeenCalledTimes(2);
    expect(mocks.deleteFile).toHaveBeenCalledWith(
      "generated/orphan.png",
      bucket,
    );
    expect(mocks.deleteFile).toHaveBeenCalledWith(
      "generated/retry.png",
      bucket,
    );
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(
      "generated/consumed.png",
    );
  });

  it("verifies bytes and persists authoritative provenance with a raw R2 checksum", async () => {
    const imageSha256 = await sha256Hex(BYTES);
    const { db, insertedValues } = saveDb([
      [preview({ imageSha256 })],
      [{ id: "folder_1" }],
    ]);
    const saved = {
      id: "media_saved",
      generationId: "aig_abcdefghijklmnop",
      url: "https://cdn.test/generated.png",
    };
    mocks.uploadFile.mockResolvedValue({
      key: "generated/aig_abcdefghijklmnop.png",
      url: saved.url,
      size: BYTES.byteLength,
      filename: "generated-aig_abcdefghijklmnop.png",
      mimeType: "image/png",
    });
    mocks.safeBatch.mockResolvedValue([[saved], [{ id: "claim" }]]);

    await expect(
      saveGeneratedImagePreview(db as never, {
        generationId: "aig_abcdefghijklmnop",
        userId: "admin_1",
        file: new File([BYTES], "preview.png", { type: "image/png" }),
        altText: "Black running shoe on white background",
        folderId: "folder_1",
        now: NOW,
      }),
    ).resolves.toEqual(saved);

    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.any(File),
      undefined,
      undefined,
      expect.objectContaining({
        sha256: expect.any(ArrayBuffer),
        objectKey: "generated/aig_abcdefghijklmnop.png",
        customMetadata: expect.objectContaining({
          source: "ai_generated",
          generationId: "aig_abcdefghijklmnop",
          promptSha256: "a".repeat(64),
        }),
      }),
    );
    expect(insertedValues[0]).toMatchObject({
      sourceType: "ai_generated",
      generationProvider: "cloudflare",
      generationModel: "@cf/black-forest-labs/flux-2-dev",
      generationPromptHash: "a".repeat(64),
      generationTotalTokens: 12,
      generationCostStatus: "not_reported",
      altText: "Black running shoe on white background",
      folderId: "folder_1",
      width: 1,
      height: 1,
    });
  });

  it("returns the prior media row when a committed save response was lost", async () => {
    const existing = {
      id: "media_existing",
      generationId: "aig_abcdefghijklmnop",
    };
    const { db } = saveDb([
      [preview({
        consumedAt: NOW,
        consumedMediaId: existing.id,
        expiresAt: new Date(NOW.getTime() - 1),
      })],
      [existing],
    ]);

    await expect(
      saveGeneratedImagePreview(db as never, {
        generationId: "aig_abcdefghijklmnop",
        userId: "admin_1",
        file: new File([BYTES], "preview.png", { type: "image/png" }),
        now: NOW,
      }),
    ).resolves.toEqual(existing);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("keeps R2 intact when the D1 batch committed but its response was lost", async () => {
    const imageSha256 = await sha256Hex(BYTES);
    const committed = {
      id: "media_committed",
      generationId: "aig_abcdefghijklmnop",
      url: "https://cdn.test/generated/aig_abcdefghijklmnop.png",
    };
    const { db, updateSetValues } = saveDb([
      [preview({ imageSha256 })],
      [committed],
    ]);
    mocks.uploadFile.mockResolvedValue({
      key: "generated/aig_abcdefghijklmnop.png",
      url: committed.url,
      size: BYTES.byteLength,
      filename: "generated-aig_abcdefghijklmnop.png",
      mimeType: "image/png",
    });
    mocks.safeBatch.mockRejectedValue(new Error("D1 response lost after commit"));

    await expect(
      saveGeneratedImagePreview(db as never, {
        generationId: "aig_abcdefghijklmnop",
        userId: "admin_1",
        file: new File([BYTES], "preview.png", { type: "image/png" }),
        now: NOW,
      }),
    ).resolves.toEqual(committed);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(updateSetValues.at(-1)).toMatchObject({
      consumedMediaId: "media_committed",
      r2Key: "generated/aig_abcdefghijklmnop.png",
      claimedAt: null,
      claimToken: null,
    });
  });

  it("retains deterministic R2 evidence instead of racing a late put after timeout", async () => {
    const imageSha256 = await sha256Hex(BYTES);
    const { db, updateSetValues } = saveDb([
      [preview({ imageSha256 })],
      [],
      (claimToken) => [{ claimToken }],
    ]);
    const ambiguous = new Error(
      "Media storage timed out. The save was not confirmed.",
    );
    ambiguous.name = "AmbiguousStorageWriteError";
    mocks.uploadFile.mockRejectedValue(ambiguous);

    await expect(
      saveGeneratedImagePreview(db as never, {
        generationId: "aig_abcdefghijklmnop",
        userId: "admin_1",
        file: new File([BYTES], "preview.png", { type: "image/png" }),
        now: NOW,
      }),
    ).rejects.toBe(ambiguous);

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(updateSetValues[0]).toMatchObject({
      r2Key: "generated/aig_abcdefghijklmnop.png",
    });
    expect(updateSetValues).toHaveLength(1);
    expect(updateSetValues[0]).toMatchObject({
      claimedAt: NOW,
      claimToken: expect.stringMatching(/^aic_/u),
      r2Key: "generated/aig_abcdefghijklmnop.png",
    });
  });

  it("never deletes prior ambiguous storage evidence when a reclaimed retry fails", async () => {
    const imageSha256 = await sha256Hex(BYTES);
    const key = "generated/aig_abcdefghijklmnop.png";
    const ambiguous = new Error("Media storage timed out");
    ambiguous.name = "AmbiguousStorageWriteError";
    const retryFailure = new Error("R2 rejected retry");
    const first = saveDb([
      [preview({ imageSha256 })],
      [],
      (claimToken) => [{ claimToken }],
    ]);
    const second = saveDb([
      [preview({
        imageSha256,
        r2Key: key,
        claimedAt: NOW,
      })],
      [],
      (claimToken) => [{ claimToken }],
    ]);
    mocks.uploadFile
      .mockRejectedValueOnce(ambiguous)
      .mockRejectedValueOnce(retryFailure);

    await expect(saveGeneratedImagePreview(first.db as never, {
      generationId: "aig_abcdefghijklmnop",
      userId: "admin_1",
      file: new File([BYTES], "preview.png", { type: "image/png" }),
      now: NOW,
    })).rejects.toBe(ambiguous);
    await expect(saveGeneratedImagePreview(second.db as never, {
      generationId: "aig_abcdefghijklmnop",
      userId: "admin_1",
      file: new File([BYTES], "preview.png", { type: "image/png" }),
      now: new Date(NOW.getTime() + 3 * 60_000),
    })).rejects.toBe(retryFailure);

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(second.updateSetValues.at(-1)).toMatchObject({
      claimedAt: null,
      claimToken: null,
    });
    expect(second.updateSetValues.at(-1)).not.toHaveProperty("r2Key");
  });

  it("rejects an unknown target folder before claiming or uploading", async () => {
    const imageSha256 = await sha256Hex(BYTES);
    const { db } = saveDb([[preview({ imageSha256 })], []]);

    await expect(
      saveGeneratedImagePreview(db as never, {
        generationId: "aig_abcdefghijklmnop",
        userId: "admin_1",
        file: new File([BYTES], "preview.png", { type: "image/png" }),
        folderId: "folder_missing",
        now: NOW,
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("fails closed when the guarded preview claim loses a race", async () => {
    const imageSha256 = await sha256Hex(BYTES);
    const { db } = saveDb([[preview({ imageSha256 })]], []);

    await expect(
      saveGeneratedImagePreview(db as never, {
        generationId: "aig_abcdefghijklmnop",
        userId: "admin_1",
        file: new File([BYTES], "preview.png", { type: "image/png" }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });
});
