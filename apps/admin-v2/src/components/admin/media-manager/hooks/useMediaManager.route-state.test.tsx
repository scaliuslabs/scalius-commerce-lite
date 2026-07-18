// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaWorkspaceRouteState } from "../types";
import { useMediaManager } from "./useMediaManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  loadFiles: vi.fn(),
  onStateChange: vi.fn(),
  folderLoadError: null as string | null,
}));

vi.mock("../api", () => ({ MediaApiClient: {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock(".", () => ({
  useMediaFiles: () => ({
    files: [],
    setFiles: vi.fn(),
    isLoading: false,
    isLoadingMore: false,
    nextCursor: null,
    hasMore: false,
    loadError: null,
    filters: { search: "", sortBy: "createdAt", sortOrder: "desc", view: "ready" },
    loadFiles: mocks.loadFiles,
    loadMore: vi.fn(),
    applyFilters: vi.fn(),
    refresh: vi.fn(),
  }),
  useFolders: () => ({
    folders: [{ id: "folder_campaign", name: "Campaign", version: 1 }],
    isLoadingFolders: false,
    folderLoadError: mocks.folderLoadError,
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

let latest: ReturnType<typeof useMediaManager>;
let state: MediaWorkspaceRouteState;

function Harness({ workspaceState }: { workspaceState: MediaWorkspaceRouteState }) {
  latest = useMediaManager({
    autoLoad: true,
    capability: "both",
    workspaceState,
    onWorkspaceStateChange: mocks.onStateChange,
  });
  return null;
}

describe("useMediaManager route authority", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.loadFiles.mockReset().mockResolvedValue(undefined);
    mocks.onStateChange.mockReset();
    mocks.folderLoadError = null;
    state = {
      view: "ready",
      folderId: "all",
      search: "",
      kind: undefined,
      sortBy: "createdAt",
      sortOrder: "desc",
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness workspaceState={state} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("sends meaningful workspace transitions to the route owner", () => {
    act(() => latest.applyFilters({ kind: "video" }));
    expect(mocks.onStateChange).toHaveBeenLastCalledWith({ kind: "video" });

    act(() => latest.setView("trash"));
    expect(mocks.onStateChange).toHaveBeenLastCalledWith({ view: "trash" });

    act(() => latest.moveToFolder("folder_campaign"));
    expect(mocks.onStateChange).toHaveBeenLastCalledWith({ folderId: "folder_campaign" });
  });

  it("replaces debounced query refinements and follows Back/Forward state", () => {
    act(() => latest.applySearch("walkthrough"));
    act(() => vi.advanceTimersByTime(300));
    expect(mocks.onStateChange).toHaveBeenLastCalledWith(
      { search: "walkthrough" },
      { replace: true },
    );

    state = {
      ...state,
      view: "trash",
      folderId: null,
      search: "receipt",
      kind: "image",
      sortBy: "filename",
      sortOrder: "asc",
    };
    act(() => root.render(<Harness workspaceState={state} />));

    expect(latest.view).toBe("trash");
    expect(latest.currentFolderId).toBeNull();
    expect(latest.filters).toMatchObject({
      search: "receipt",
      kind: "image",
      sortBy: "filename",
      sortOrder: "asc",
      view: "trash",
    });
  });

  it("repairs a missing folder only after the folder authority loaded successfully", () => {
    mocks.folderLoadError = "temporarily unavailable";
    state = { ...state, folderId: "folder_missing" };
    act(() => root.render(<Harness workspaceState={state} />));
    expect(mocks.onStateChange).not.toHaveBeenCalled();

    mocks.folderLoadError = null;
    act(() => root.render(<Harness workspaceState={state} />));
    expect(mocks.onStateChange).toHaveBeenLastCalledWith(
      { folderId: "all" },
      { replace: true },
    );
  });
});
