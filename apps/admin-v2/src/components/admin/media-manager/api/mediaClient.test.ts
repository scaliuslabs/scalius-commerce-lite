import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ getApiV1AdminMedia: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);

import { MediaApiClient, toMediaFile, type MediaFileDto } from "./mediaClient";

function dto(posterUrl: string | null): MediaFileDto {
  return {
    id: "media_video_1",
    filename: "walkthrough.mp4",
    url: "https://media.example.com/media/media_video_1.mp4",
    objectKey: "media/media_video_1.mp4",
    kind: "video",
    size: 23_560_000,
    mimeType: "video/mp4",
    posterMediaId: "media_image_1",
    posterUrl,
    folderId: null,
    status: "ready",
    version: 2,
    createdAt: 1,
    updatedAt: 1,
    trashedAt: null,
    deletedAt: null,
  };
}

describe("toMediaFile", () => {
  it("preserves a projected off-page poster URL after a list reload", () => {
    expect(toMediaFile(dto("https://media.example.com/media/media_image_1.jpg")).posterUrl)
      .toBe("https://media.example.com/media/media_image_1.jpg");
  });

  it("preserves a fail-closed null poster projection", () => {
    expect(toMediaFile(dto(null)).posterUrl).toBeNull();
  });
});

describe("MediaApiClient reads", () => {
  afterEach(() => vi.clearAllMocks());

  function listResponse(files: MediaFileDto[]) {
    return {
      data: {
        success: true,
        data: { files, pagination: { limit: 24, hasMore: false, nextCursor: null } },
      },
    };
  }

  it("omits blank search and maps the listed files", async () => {
    sdk.getApiV1AdminMedia.mockResolvedValue(listResponse([dto(null)]));

    const result = await MediaApiClient.fetchFiles(undefined, 24, {
      search: "  ",
      sortBy: "createdAt",
      sortOrder: "desc",
      view: "ready",
    });

    expect(result.files).toHaveLength(1);
    expect(sdk.getApiV1AdminMedia).toHaveBeenCalledWith({
      query: {
        cursor: undefined,
        limit: 24,
        search: undefined,
        folderId: undefined,
        sortBy: "createdAt",
        sortOrder: "desc",
        kind: undefined,
        view: "ready",
      },
    });
  });

  it("keeps the unfiled folder filter explicit", async () => {
    sdk.getApiV1AdminMedia.mockResolvedValue(listResponse([]));

    await MediaApiClient.fetchFiles(undefined, 24, {
      search: "",
      folderId: null,
      sortBy: "filename",
      sortOrder: "asc",
      view: "ready",
    });

    expect(sdk.getApiV1AdminMedia.mock.calls[0]![0].query.folderId).toBe("root");
  });
});
