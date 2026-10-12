// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";
import type { LibraryMediaFile } from "./types";
import { setLocale } from "~/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ fetchFiles: vi.fn() }));
vi.mock("./api", () => ({ MediaApiClient: api }));
vi.mock("./hooks", async () => ({
  useMediaFiles: (await import("./hooks/useMediaFiles")).useMediaFiles,
  useFolders: () => ({
    folders: [], currentFolderId: "all", isLoadingFolders: false, folderLoadError: null,
    loadFolders: vi.fn(), createFolder: vi.fn(), renameFolder: vi.fn(), deleteFolder: vi.fn(), moveToFolder: vi.fn(),
  }),
  useMediaUpload: () => ({ queue: [], uploadFiles: vi.fn(), retry: vi.fn(), dismiss: vi.fn() }),
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
function Harness({ picker = false, unavailableFileIds = [] }: { picker?: boolean; unavailableFileIds?: string[] }) {
  latest = useMediaManager({ autoLoad: false, capability: "both", unavailableFileIds, onSelectMultiple: picker ? onAdd : undefined });
  return <MediaWorkspace manager={latest} capability="both" picker={picker} multiple={picker} />;
}

describe("MediaWorkspace page and picker continuity", () => {
  let host: HTMLDivElement;
  let root: Root;
  const cards = () => [...host.querySelectorAll("article[role=listitem]")];
  const primary = (index: number) => cards()[index]?.querySelector<HTMLButtonElement>(":scope > button");
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label)!;
  const click = (label: string) => act(() => button(label).click());

  beforeEach(() => {
    setLocale("en");
    api.fetchFiles.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
    act(() => latest.setFiles(files(125)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
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
