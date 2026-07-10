// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/api-functions/media", () => ({
  getMediaList: vi.fn(),
  deleteMedia: vi.fn(),
  updateMedia: vi.fn(),
  getMediaFolders: vi.fn(),
  createMediaFolder: vi.fn(),
  deleteMediaFolder: vi.fn(),
  moveMediaFiles: vi.fn(),
}));

import { MediaApiClient } from "./mediaClient";

const provenanceHeaders = {
  "Content-Type": "image/png",
  "X-Scalius-Generation-Id": "aig_abcdefghijklmnop",
  "X-Scalius-Generation-Provider": "cloudflare",
  "X-Scalius-Generation-Model": encodeURIComponent(
    "@cf/black-forest-labs/flux-2-dev",
  ),
  "X-Scalius-Generation-Prompt-Hash": "a".repeat(64),
  "X-Scalius-Generation-Cost-Status": "not_reported",
  "X-Scalius-Generation-Expires-At": "2026-07-10T23:59:00.000Z",
  "X-Scalius-Generation-Input-Tokens": "3",
  "X-Scalius-Generation-Output-Tokens": "7",
  "X-Scalius-Generation-Total-Tokens": "10",
};

describe("generated media client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires and decodes the bounded binary provenance headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: provenanceHeaders,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      MediaApiClient.generateImagePreview({
        prompt: "Studio shoe photo",
        aspectRatio: "1:1",
      }),
    ).resolves.toMatchObject({
      generationId: "aig_abcdefghijklmnop",
      mediaType: "image/png",
      provider: "cloudflare",
      model: "@cf/black-forest-labs/flux-2-dev",
      promptHash: "a".repeat(64),
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      cost: { status: "not_reported" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/media/image-generation/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "Studio shoe photo",
          aspectRatio: "1:1",
        }),
      }),
    );
  });

  it("posts the exact preview bytes and authority ID for an idempotent save", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: provenanceHeaders,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            file: {
              id: "media_1",
              filename: "generated.png",
              url: "https://cdn.test/generated.png",
              size: 3,
              mimeType: "image/png",
              folderId: null,
              sourceType: "ai_generated",
              generationId: "aig_abcdefghijklmnop",
              createdAt: 1_783_700_000,
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const preview = await MediaApiClient.generateImagePreview({
      prompt: "Studio shoe photo",
      aspectRatio: "auto",
    });

    await expect(
      MediaApiClient.saveGeneratedImage({
        preview,
        altText: "Black running shoe",
        folderId: "folder_1",
      }),
    ).resolves.toMatchObject({
      id: "media_1",
      sourceType: "ai_generated",
      generationId: "aig_abcdefghijklmnop",
    });

    const saveInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = saveInit.body as FormData;
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/admin/media/image-generation/save",
    );
    expect(body.get("generationId")).toBe("aig_abcdefghijklmnop");
    expect(body.get("altText")).toBe("Black running shoe");
    expect(body.get("folderId")).toBe("folder_1");
    expect(body.get("file")).toBeInstanceOf(File);
    expect((body.get("file") as File).size).toBe(3);
  });
});
