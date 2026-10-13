// @vitest-environment happy-dom
import { PermissionProvider } from "~/contexts/PermissionContext";

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";
import type { LibraryMediaFile, MediaCapability, MediaWorkspaceRouteState } from "./types";
import { setLocale } from "~/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ fetchFiles: vi.fn(), uploadFiles: vi.fn() }));
vi.mock("@tanstack/react-router", async (original) => ({ ...(await original<object>()), useBlocker: () => ({ status: "idle" }) }));
vi.mock("./api", () => ({ MediaApiClient: api }));
vi.mock("./hooks", async () => ({
  useMediaFiles: (await import("./hooks/useMediaFiles")).useMediaFiles,
  useFolders: () => ({
    folders: [], currentFolderId: "all", isLoadingFolders: false, folderLoadError: null,
    loadFolders: vi.fn(), createFolder: vi.fn(), renameFolder: vi.fn(), deleteFolder: vi.fn(), moveToFolder: vi.fn(),
  }),
  useMediaUpload: () => ({ queue: [], isUploading: false, pendingCount: 0, uploadFiles: api.uploadFiles, retry: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("./components", async () => ({
  MediaGallery: (await import("./components/MediaGallery")).MediaGallery,
  MediaFilterBar: (await import("./components/MediaFilterBar")).MediaFilterBar,
  MediaUploadQueue: () => null,
  MediaPreview: ({ open, file, onNavigate }: {
    open: boolean;
    file: LibraryMediaFile | null;
    onNavigate: (direction: -1 | 1) => void;
  }) => open ? <div data-preview>
    <span>{file?.filename}</span>
    <button type="button" data-preview-next onClick={() => onNavigate(1)}>Next file</button>
  </div> : null,
}));
vi.mock("./components/OptimizeImagesButton", () => ({
  OptimizeImagesButton: () => <button type="button">Optimize images</button>,
}));
vi.mock("~/components/admin/shared/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("~/components/admin/states/store-owner", () => ({ useStoreOwnerName: () => "Store owner" }));

function files(count: number): LibraryMediaFile[] {
  const date = new Date("2026-10-12T00:00:00Z");
  return Array.from({ length: count }, (_, index) => ({
    id: `media_${index}`, filename: `file-${index}.webp`, url: `https://cdn.example.com/file-${index}.webp`,
    objectKey: `media/file-${index}.webp`, kind: "image", mimeType: "image/webp", size: 100,
    altText: null, caption: null, width: 100, height: 100, durationMs: null,
    posterMediaId: null, posterUrl: null, folderId: null, status: "ready", version: 1,
    createdAt: date, updatedAt: date, trashedAt: null, deletedAt: null, usageCount: 0, keptForOrders: false,
  }));
}

let latest: ReturnType<typeof useMediaManager>;
const onAdd = vi.fn();
function Harness({ picker = false, unavailableFileIds = [], capability = "both", routeControlled = false, permissions }: {
  picker?: boolean; unavailableFileIds?: string[]; capability?: MediaCapability; routeControlled?: boolean; permissions?: string[];
}) {
  const [workspaceState, setWorkspaceState] = useState<MediaWorkspaceRouteState>({
    view: "ready", folderId: "all", search: "", sortBy: "createdAt", sortOrder: "desc",
  });
  latest = useMediaManager({
    autoLoad: routeControlled, capability, unavailableFileIds, onSelectMultiple: picker ? onAdd : undefined,
    ...(routeControlled ? {
      workspaceState,
      onWorkspaceStateChange: (updates: Partial<MediaWorkspaceRouteState>) => setWorkspaceState((current) => ({ ...current, ...updates })),
    } : {}),
  });
  return <PermissionProvider isSuperAdmin={permissions === undefined} permissions={permissions}><MediaWorkspace manager={latest} capability={capability} picker={picker} multiple={picker} /></PermissionProvider>;
}

describe("MediaWorkspace page and picker continuity", () => {
  let host: HTMLDivElement;
  let root: Root;
  const cards = () => [...host.querySelectorAll("article[role=listitem]")];
  const primary = (index: number) => cards()[index]?.querySelector<HTMLButtonElement>(":scope > button");
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label)!;
  const click = (label: string) => act(() => button(label).click());
  const searchInput = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const typeSearch = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(searchInput(), value);
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const serveSearchResults = () => api.fetchFiles.mockImplementation(async (_cursor, limit, filters) => ({
    files: files(5).filter((file) => file.filename.includes(filters.search)),
    pagination: { limit, hasMore: false, nextCursor: null },
  }));

  beforeEach(() => {
    setLocale("en");
    api.fetchFiles.mockReset();
    api.uploadFiles.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
    act(() => latest.setFiles(files(125)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it.each([
    { permissions: ["media.view"], upload: false, folders: false, select: false },
    { permissions: ["media.view", "media.upload"], upload: true, folders: false, select: true },
    { permissions: ["media.view", "media.delete"], upload: false, folders: false, select: true },
    { permissions: ["media.view", "media.manage_folders"], upload: false, folders: true, select: true },
  ])("matches mutation controls to $permissions", ({ permissions, upload, folders, select }) => {
    act(() => root.render(<Harness permissions={permissions} />));
    expect(Boolean(host.querySelector('input[type="file"]'))).toBe(upload);
    expect(Boolean(button("Upload files"))).toBe(upload);
    expect(Boolean(button("Optimize images"))).toBe(upload);
    expect(Boolean(button("Folder actions"))).toBe(folders);
    expect(Boolean(button("Select"))).toBe(select);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["image"], "image.webp", { type: "image/webp" })] } });
    act(() => host.querySelector("article")!.dispatchEvent(drop));
    expect(api.uploadFiles).toHaveBeenCalledTimes(upload ? 1 : 0);
    act(() => primary(0)!.click());
    expect(host.querySelector("[data-preview]")?.textContent).toContain("file-0.webp");
  });

  it("lets a viewer select existing files in a picker without offering uploads or folder edits", () => {
    act(() => root.render(<Harness picker permissions={["media.view"]} />));
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(button("Folder actions")).toBeUndefined();
    act(() => primary(0)!.click());
    expect(latest.selectedFileIds).toContain("media_0");
    expect(button("Add 1").disabled).toBe(false);
  });

  it("mounts at most 50 tiles and pages cached rows without a read", () => {
    expect(cards()).toHaveLength(50);
    expect(primary(0)?.textContent).toContain("file-0.webp");
    click("Next");
    expect(cards()).toHaveLength(50);
    expect(primary(0)?.textContent).toContain("file-50.webp");
    click("Next");
    expect(cards()).toHaveLength(25);
    click("Previous");
    expect(primary(0)?.textContent).toContain("file-50.webp");
    expect(latest.files).toHaveLength(125);
    expect(api.fetchFiles).not.toHaveBeenCalled();
  });

  it("adds each shown page without dropping selections from previous pages", () => {
    click("Select");
    click("Select all shown");
    expect(latest.selectedFileIds).toHaveLength(50);
    click("Next");
    expect(button("Select all shown")).toBeDefined();
    click("Select all shown");
    expect(latest.selectedFileIds).toEqual(files(100).map((file) => file.id));
    click("Previous");
    expect(button("Select all shown")).toBeUndefined();
    expect(cards().every((card) => card.querySelector("button")?.getAttribute("aria-pressed") === "true")).toBe(true);
  });

  it("anchors Shift after page select-all without discarding other pages", () => {
    click("Select");
    act(() => primary(2)?.click());
    click("Next");
    click("Select all shown");
    click("Next");
    act(() => primary(5)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(latest.selectedFileIds).toEqual(["media_2", ...files(106).slice(50).map((file) => file.id)]);
    expect(latest.selectedFileIds).not.toContain("media_3");
  });

  it("keeps Shift ranges across unmounted rows in the full loaded order", () => {
    click("Select");
    act(() => primary(10)?.click());
    click("Next");
    act(() => primary(5)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(latest.selectedFileIds).toEqual(files(56).slice(10).map((file) => file.id));
  });

  it("excludes already-attached picker rows from page selection", () => {
    act(() => root.render(<Harness picker unavailableFileIds={["media_0", "media_1"]} />));
    act(() => latest.setSelectionMode(true));
    click("Select all shown");
    expect(latest.selectedFileIds).toHaveLength(48);
    expect(latest.selectedFileIds).not.toContain("media_0");
    expect(primary(0)?.disabled).toBe(true);
  });

  it("keeps preview navigation and video posters independent of the mounted page", () => {
    const all = files(125);
    all[0] = { ...all[0]!, kind: "video", mimeType: "video/mp4", posterMediaId: "media_90" };
    act(() => latest.setFiles(all));
    expect(cards()[0]?.querySelector("img")?.getAttribute("src")).toContain("file-90.webp");
    act(() => primary(49)?.click());
    expect(host.querySelector("[data-preview]")?.textContent).toContain("file-49.webp");
    act(() => host.querySelector<HTMLButtonElement>("[data-preview-next]")?.click());
    expect(host.querySelector("[data-preview]")?.textContent).toContain("file-50.webp");
    expect(latest.pageIndex).toBe(0);
    expect(cards()).toHaveLength(50);
  });

  it.each([
    { name: "standalone", picker: false, capability: "both" as const, routeControlled: false },
    { name: "route-controlled", picker: false, capability: "both" as const, routeControlled: true },
    { name: "fixed image picker", picker: true, capability: "image" as const, routeControlled: false },
  ])("clears a pending search with visible rows in $name", async ({ picker, capability, routeControlled }) => {
    vi.useFakeTimers();
    serveSearchResults();
    await act(async () => root.render(<Harness picker={picker} capability={capability} routeControlled={routeControlled} />));
    await act(async () => latest.applyFilters({ sortBy: "filename", sortOrder: "asc" }));
    expect(cards()).toHaveLength(5);
    // A non-default sort or a fixed picker capability is not a filter to clear.
    expect(button("Clear filters")).toBeUndefined();
    act(() => { latest.setSelectionMode(true); latest.replaceSelection(["media_0"]); });
    typeSearch("file-1");
    act(() => vi.advanceTimersByTime(100));
    await act(async () => button("Clear filters").click());
    expect(searchInput().value).toBe("");
    expect(document.activeElement).toBe(searchInput());
    await act(async () => vi.advanceTimersByTime(1000));
    // A stale debounce would narrow the actual rendered gallery to one row.
    expect(cards()).toHaveLength(5);
    expect(searchInput().value).toBe("");
    expect(latest.filters).toMatchObject({ search: "", sortBy: "filename", sortOrder: "asc", view: "ready" });
    expect(latest.filters.kind).toBe(capability === "image" ? "image" : undefined);
    expect(latest.selectedFileIds).toEqual([]);
    expect(latest.selectionMode).toBe(picker);
    expect(button("Clear filters")).toBeUndefined();
  });

  it("offers reset for a type-only filter with results", async () => {
    serveSearchResults();
    await act(async () => latest.applyFilters({ kind: "image" }));
    expect(cards()).toHaveLength(5);
    await act(async () => button("Clear filters").click());
    expect(latest.filters.kind).toBeUndefined();
    expect(cards()).toHaveLength(5);
    expect(button("Clear filters")).toBeUndefined();
  });

  it("also cancels pending typing through the existing empty-results reset", async () => {
    vi.useFakeTimers();
    serveSearchResults();
    typeSearch("no-match");
    await act(async () => vi.advanceTimersByTime(300));
    expect(cards()).toHaveLength(0);
    typeSearch("file-1");
    act(() => vi.advanceTimersByTime(100));
    expect([...host.querySelectorAll("button")].filter((item) => item.textContent?.trim() === "Clear filters")).toHaveLength(1);
    await act(async () => button("Clear filters").click());
    await act(async () => vi.advanceTimersByTime(1000));
    expect(cards()).toHaveLength(5);
    expect(searchInput().value).toBe("");
  });

  it("places Upload in the standalone header and keeps picker-local Upload", () => {
    const header = host.querySelector('[data-slot="page-header"]');
    expect(header?.textContent).toContain("Upload files");
    expect(header?.textContent).toContain("Optimize images");
    expect([...host.querySelectorAll("button")].filter((item) => item.textContent?.trim() === "Upload files")).toHaveLength(1);
    act(() => root.render(<Harness picker />));
    expect(host.querySelector('[data-slot="page-header"]')).toBeNull();
    expect(button("Upload files")).toBeDefined();
  });
});
