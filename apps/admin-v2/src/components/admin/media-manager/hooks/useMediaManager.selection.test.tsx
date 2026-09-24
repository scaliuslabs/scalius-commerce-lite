// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
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
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
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
    retry: vi.fn(),
    dismiss: vi.fn(),
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
    usageCount: 0,
    keptForOrders: false,
  };
}

type Manager = ReturnType<typeof useMediaManager>;
let latest: Manager;
const onSelectMultiple = vi.fn();
let unavailableFileIds: string[] = [];
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
    unavailableFileIds,
    onSelectMultiple,
  });
  return null;
}

describe("useMediaManager off-page selection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    hookState.files = [libraryFile("visible", "visible-fresh.webp")];
    unavailableFileIds = [];
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

  it("keeps already-attached assets out of a new picker selection", () => {
    unavailableFileIds = ["visible", "off-page"];
    act(() => root.render(<Harness />));

    act(() => latest.replaceSelection(["off-page", "visible"]));
    expect(latest.selectedFileIds).toEqual([]);

    act(() => latest.selectAllVisible());
    expect(latest.selectedFileIds).toEqual([]);

    act(() => latest.toggleSelection("visible"));
    expect(latest.selectedFileIds).toEqual([]);
  });
});

describe("useMediaManager trash and delete", () => {
  let host: HTMLDivElement;
  let root: Root;

  function ManagerHarness() {
    latest = useMediaManager({ autoLoad: false, capability: "both" });
    return null;
  }

  beforeEach(() => {
    hookState.files = [
      { ...libraryFile("used", "used.webp"), usageCount: 2 },
      libraryFile("free", "free.webp"),
      { ...libraryFile("ordered", "ordered.webp"), keptForOrders: true },
    ];
    Object.values(api).forEach((mock) => mock.mockReset().mockResolvedValue(undefined));
    Object.values(toast).forEach((mock) => mock.mockReset());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<ManagerHarness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("offers Undo for 10 seconds after a file moves to trash, restoring the trashed version", async () => {
    const trashed = { ...hookState.files[1]!, status: "trashed" as const, version: 3 };
    api.trashFile.mockResolvedValue(trashed);

    await act(async () => latest.mutateOne(hookState.files[1]!, "trash"));

    expect(toast.success).toHaveBeenCalledWith("Moved to trash", expect.objectContaining({
      duration: 10_000,
      action: expect.objectContaining({ label: "Undo" }),
    }));
    const [, options] = toast.success.mock.calls[0] as [string, { action: { onClick: () => void } }];
    await act(async () => options.action.onClick());
    expect(api.restoreFile).toHaveBeenCalledWith(trashed);
    expect(toast.success).toHaveBeenLastCalledWith("File restored");
  });

  it("undoes a bulk move to trash for every file it moved", async () => {
    api.trashFile.mockImplementation(async (file: LibraryMediaFile) => ({ ...file, status: "trashed", version: file.version + 1 }));
    act(() => latest.replaceSelection(["used", "free"]));

    await act(async () => latest.mutateSelected("trash"));

    expect(toast.success).toHaveBeenCalledWith("2 files moved to trash", expect.objectContaining({ duration: 10_000 }));
    const [, options] = toast.success.mock.calls[0] as [string, { action: { onClick: () => void } }];
    await act(async () => options.action.onClick());
    expect(api.restoreFile.mock.calls.map(([file]) => [file.id, file.version]).sort()).toEqual([["free", 3], ["used", 3]]);
    expect(toast.success).toHaveBeenLastCalledWith("2 files restored");
  });

  it("never asks the server to delete files that are still used and says they stay in Trash", async () => {
    act(() => latest.replaceSelection(["used", "free", "ordered"]));

    await act(async () => latest.mutateSelected("permanent"));

    expect(api.permanentlyDeleteFile).toHaveBeenCalledOnce();
    expect(api.permanentlyDeleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: "free" }));
    expect(toast.info).toHaveBeenCalledWith("2 files stay in Trash because they're still used.");
    expect(latest.selectedFileIds.sort()).toEqual(["ordered", "used"]);
  });

  it("explains a refused delete in plain words instead of the server's message", async () => {
    api.permanentlyDeleteFile.mockRejectedValue(
      new AdminApiResponseError("Remove this media from every saved storefront surface", 409, "MEDIA_DEPENDENCY_CONFLICT"),
    );

    await act(async () => latest.mutateOne(hookState.files[1]!, "permanent"));

    expect(toast.error).toHaveBeenCalledWith("Couldn't change this file. Try again.", {
      description: "It's still used. Open it to see where.",
    });
  });
});
