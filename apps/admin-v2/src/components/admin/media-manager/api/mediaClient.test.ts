import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaFileDto } from "~/lib/api-functions/media";
import { MediaApiClient, toMediaFile } from "./mediaClient";

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
  afterEach(() => vi.unstubAllGlobals());

  it("reads the live media endpoint without reusing a cached empty result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      success: true,
      data: {
        files: [dto(null)],
        pagination: { limit: 24, hasMore: false, nextCursor: null },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await MediaApiClient.fetchFiles(undefined, 24, {
      search: "  ",
      sortBy: "createdAt",
      sortOrder: "desc",
      view: "ready",
    });

    expect(result.files).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/media?limit=24&sortBy=createdAt&sortOrder=desc&view=ready",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "Cache-Control": "no-cache" }),
      }),
    );
  });

  it("keeps the unfiled folder filter explicit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      success: true,
      data: {
        files: [],
        pagination: { limit: 24, hasMore: false, nextCursor: null },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await MediaApiClient.fetchFiles(undefined, 24, {
      folderId: null,
      sortBy: "filename",
      sortOrder: "asc",
      view: "ready",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("folderId=root"),
      expect.any(Object),
    );
  });
});
