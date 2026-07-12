import { describe, expect, it } from "vitest";
import type { MediaFileDto } from "~/lib/api-functions/media";
import { toMediaFile } from "./mediaClient";

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
