// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryMediaFile, MediaFile } from "../types";
import { useMediaManager } from "./useMediaManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hookState = vi.hoisted(() => ({ files: [] as LibraryMediaFile[] }));
const api = vi.hoisted(() => ({
  trashFile: vi.fn(),
  restoreFile: vi.fn(),
  permanentlyDeleteFile: vi.fn(),
  moveFiles: vi.fn(),
}));

vi.mock("../api", () => ({ MediaApiClient: api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock(".", () => ({
  useMediaFiles: () => ({
    files: hookState.files,
    setFiles: vi.fn(),
    isLoading: false,
    isLoadingMore: false,
    nextCursor: null,
    hasMore: false,
    loadError: null,
    filters: { search: "", sortBy: "createdAt", sortOrder: "desc", view: "ready" },
    loadFiles: vi.fn(),
    loadMore: vi.fn(),
    applyFilters: vi.fn(),
    refresh: vi.fn(),
  }),
  useFolders: () => ({
    folders: [],
    isLoadingFolders: false,
    currentFolderId: "all",
    loadFolders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveToFolder: vi.fn(),
  }),
  useMediaUpload: () => ({
    queue: [],
    uploadFiles: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    clearFinished: vi.fn(),
  }),
}));

function libraryFile(id: string, filename: string): LibraryMediaFile {
  const createdAt = new Date("2026-07-14T00:00:00.000Z");
  return {
    id,
    url: `https://cdn.example.com/${filename}`,
    objectKey: `media/${filename}`,
    filename,
    kind: "image",
    mimeType: "image/webp",
    size: 100,
    altText: null,
    caption: null,
    width: 100,
    height: 100,
    durationMs: null,
    posterMediaId: null,
    posterUrl: null,
    folderId: null,
    status: "ready",
    version: 2,
    createdAt,
    updatedAt: createdAt,
    trashedAt: null,
    deletedAt: null,
  };
}

type Manager = ReturnType<typeof useMediaManager>;
let latest: Manager;
const onSelectMultiple = vi.fn();
const offPage: MediaFile = {
  id: "off-page",
  url: "https://cdn.example.com/off-page.webp",
  filename: "off-page.webp",
  size: 90,
  createdAt: new Date("2026-07-13T00:00:00.000Z"),
  mimeType: "image/webp",
};

function Harness() {
  latest = useMediaManager({
    autoLoad: false,
    capability: "both",
    initialSelectedFiles: [offPage, offPage],
    onSelectMultiple,
  });
  return null;
}

describe("useMediaManager off-page selection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    hookState.files = [libraryFile("visible", "visible-fresh.webp")];
    onSelectMultiple.mockReset();
    Object.values(api).forEach((mock) => mock.mockReset().mockResolvedValue(undefined));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("dedupes and submits caller-provided selections outside the loaded page", () => {
    act(() => latest.replaceSelection(["off-page", "visible", "off-page"]));

    expect(latest.selectedFileIds).toEqual(["off-page", "visible"]);
    expect(latest.selectedFiles.map((file) => file.filename)).toEqual([
      "off-page.webp",
      "visible-fresh.webp",
    ]);
    expect(latest.selectedLibraryFiles.map((file) => file.id)).toEqual(["visible"]);

    act(() => latest.addSelected());
    expect(onSelectMultiple).toHaveBeenLastCalledWith(latest.selectedFiles);
  });

  it("never sends a generic off-page picker value to library mutation APIs", async () => {
    act(() => latest.replaceSelection(["off-page", "visible"]));

    await act(async () => latest.mutateSelected("trash"));

    expect(api.trashFile).toHaveBeenCalledOnce();
    expect(api.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "visible", filename: "visible-fresh.webp" }),
    );
    expect(api.trashFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "off-page" }),
    );
  });

  it("does not reintroduce a caller value after it becomes visible and is deselected", () => {
    act(() => latest.replaceSelection(["off-page", "visible"]));
    hookState.files = [
      libraryFile("visible", "visible-fresh.webp"),
      libraryFile("off-page", "off-page-fresh.webp"),
    ];
    act(() => root.render(<Harness />));
    act(() => latest.toggleSelection("off-page"));
    act(() => latest.addSelected());

    expect(latest.selectedFileIds).toEqual(["visible"]);
    expect(onSelectMultiple).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "visible", filename: "visible-fresh.webp" }),
    ]);
  });
});
