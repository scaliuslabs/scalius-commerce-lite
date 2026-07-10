import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeBatch: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/database/client")>()),
  safeBatch: mocks.safeBatch,
}));

vi.mock("../../integrations/storage", () => ({
  uploadFile: mocks.uploadFile,
  deleteFile: mocks.deleteFile,
  extractKeyFromUrl: (url: string) => new URL(url).pathname.replace(/^\//, ""),
}));

import {
  enforceGeneratedImageGenerationLimit,
  recordGeneratedImagePreview,
  saveGeneratedImagePreview,
  sha256Hex,
} from "./generated-image.service";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

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
    claimedAt: null,
    claimToken: null,
    consumedAt: null,
    ...overrides,
  };
}

function saveDb(selectResults: unknown[][], claimRows: unknown[] = [{ id: "claim" }]) {
  const insertedValues: Array<Record<string, unknown>> = [];
  let updateCount = 0;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => selectResults.shift() ?? []),
      })),
    })),
    update: vi.fn(() => {
      updateCount += 1;
      const current = updateCount;
      return {
        set: vi.fn((setValue: Record<string, unknown>) => {
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
  return { db, insertedValues };
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

  it("enforces the D1-backed per-admin generation bound before provider work", async () => {
    const { db } = recordDb(5);

    await expect(
      enforceGeneratedImageGenerationLimit(db as never, "admin_1", NOW),
    ).rejects.toMatchObject({ status: 429, code: "RATE_LIMIT" });
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
      key: "generated.png",
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
    });
  });

  it("returns the prior media row when a committed save response was lost", async () => {
    const existing = {
      id: "media_existing",
      generationId: "aig_abcdefghijklmnop",
    };
    const { db } = saveDb([
      [preview({ consumedAt: NOW })],
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
      url: "https://cdn.test/generated.png",
    };
    const { db } = saveDb([
      [preview({ imageSha256 })],
      [committed],
    ]);
    mocks.uploadFile.mockResolvedValue({
      key: "generated.png",
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
