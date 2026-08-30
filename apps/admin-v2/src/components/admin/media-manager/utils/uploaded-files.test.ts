import { describe, expect, it } from "vitest";
import type { LibraryMediaFile, MediaFilterOptions } from "../types";
import { mergeUploadedFiles } from "./uploaded-files";

const newestFirst: MediaFilterOptions = {
  search: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  view: "ready",
};

function file(
  id: string,
  filename: string,
  overrides: Partial<LibraryMediaFile> = {},
): LibraryMediaFile {
  const createdAt = new Date(`2026-08-${id.padStart(2, "0")}T00:00:00.000Z`);
  return {
    id,
    url: `https://cloud.example.test/media/${filename}`,
    objectKey: `media/${filename}`,
    filename,
    kind: "image",
    size: 100,
    mimeType: "image/png",
    altText: null,
    caption: null,
    width: 100,
    height: 100,
    durationMs: null,
    posterMediaId: null,
    posterUrl: null,
    folderId: null,
    status: "ready",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    trashedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("mergeUploadedFiles", () => {
  it("makes a completed newest upload visible immediately without duplicates", () => {
    const existing = file("01", "existing.png");
    const uploaded = file("02", "uploaded.png");

    expect(mergeUploadedFiles([existing], [uploaded, uploaded], newestFirst))
      .toEqual([uploaded, existing]);
  });

  it("honors the active search, kind, folder, and view", () => {
    const uploaded = file("02", "campaign-hero.png", { folderId: "campaign" });

    expect(mergeUploadedFiles([], [uploaded], {
      ...newestFirst,
      search: "campaign",
      kind: "image",
      folderId: "campaign",
    })).toEqual([uploaded]);
    expect(mergeUploadedFiles([], [uploaded], { ...newestFirst, search: "receipt" })).toEqual([]);
    expect(mergeUploadedFiles([], [uploaded], { ...newestFirst, kind: "video" })).toEqual([]);
    expect(mergeUploadedFiles([], [uploaded], { ...newestFirst, folderId: null })).toEqual([]);
    expect(mergeUploadedFiles([], [uploaded], { ...newestFirst, view: "trash" })).toEqual([]);
  });

  it("uses the active sort and preserves the number of already loaded rows", () => {
    const current = Array.from({ length: 30 }, (_, index) => file(
      String(index + 1),
      `file-${String(index + 1).padStart(2, "0")}.png`,
      { size: index + 1 },
    ));
    const uploaded = file("31", "file-31.png", { size: 0 });

    const merged = mergeUploadedFiles(current, [uploaded], {
      ...newestFirst,
      sortBy: "size",
      sortOrder: "asc",
    });

    expect(merged).toHaveLength(30);
    expect(merged[0]).toBe(uploaded);
    expect(merged.at(-1)?.size).toBe(29);
  });
});
