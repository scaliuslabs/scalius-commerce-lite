import { describe, expect, it } from "vitest";
import { resolveSavedPoster } from "./poster";
import type { LibraryMediaFile } from "../types";

function file(overrides: Partial<LibraryMediaFile> = {}): LibraryMediaFile {
  return {
    id: "media_video_1",
    url: "https://cdn.example.com/video.mp4",
    filename: "video.mp4",
    objectKey: "media/video.mp4",
    kind: "video",
    size: 10,
    mimeType: "video/mp4",
    altText: null,
    caption: null,
    width: null,
    height: null,
    durationMs: null,
    posterMediaId: "media_poster_1",
    posterUrl: "https://cdn.example.com/poster.jpg",
    folderId: null,
    status: "ready",
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    trashedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("resolveSavedPoster", () => {
  it("preserves an off-page poster ID and URL when the visible page does not contain it", () => {
    expect(resolveSavedPoster(file(), [])).toEqual({
      poster: null,
      posterMediaId: "media_poster_1",
      posterUrl: "https://cdn.example.com/poster.jpg",
    });
  });

  it("uses a loaded image without losing the saved authority", () => {
    const poster = file({ id: "media_poster_1", kind: "image", url: "https://cdn.example.com/fresh.jpg", mimeType: "image/jpeg", posterMediaId: null });
    expect(resolveSavedPoster(file(), [poster])).toEqual({
      poster,
      posterMediaId: "media_poster_1",
      posterUrl: "https://cdn.example.com/fresh.jpg",
    });
  });
});
