// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryMediaFile } from "../types";
import { MediaCard } from "./MediaCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file: LibraryMediaFile = {
  id: "media_1",
  url: "https://cdn.example.com/media_1.webp",
  objectKey: "media/media_1.webp",
  filename: "product-front.webp",
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
  version: 1,
  createdAt: new Date("2026-07-14T00:00:00.000Z"),
  updatedAt: new Date("2026-07-14T00:00:00.000Z"),
  trashedAt: null,
  deletedAt: null,
  usageCount: 0,
  keptForOrders: false,
};

describe("MediaCard picker management boundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(allowManagement: boolean, unavailable = false, selectionMode = false) {
    act(() => root.render(
      <MediaCard
        file={file}
        selected={false}
        selectionMode={selectionMode}
        unavailable={unavailable}
        allowManagement={allowManagement}
        view="ready"
        onActivate={vi.fn()}
        onPreview={vi.fn()}
        onToggle={vi.fn()}
        onLifecycle={vi.fn()}
      />,
    ));
  }

  it("keeps Preview but removes lifecycle actions in picker mode", () => {
    render(false);

    expect(host.querySelector('button[aria-label="Preview product-front.webp"]')).toBeTruthy();
    expect(host.querySelector('button[aria-label="Actions for product-front.webp"]')).toBeNull();
  });

  it("keeps Preview and lifecycle actions in the standalone library", () => {
    render(true);

    expect(host.querySelector('button[aria-label="Preview product-front.webp"]')).toBeTruthy();
    expect(host.querySelector('button[aria-label="Actions for product-front.webp"]')).toBeTruthy();
  });

  it("marks already-attached picker assets as unavailable instead of selected", () => {
    render(false, true, true);

    const asset = host.querySelector<HTMLButtonElement>('button[aria-label="Already added product-front.webp"]');
    expect(asset?.disabled).toBe(true);
    expect(asset?.getAttribute("aria-pressed")).toBeNull();
    expect(host.textContent).toContain("Added");
  });
});

describe("MediaCard usage", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(view: "ready" | "trash", usage: Partial<LibraryMediaFile>) {
    act(() => root.render(
      <MediaCard
        file={{ ...file, ...usage }}
        selected={false}
        selectionMode={false}
        allowManagement
        view={view}
        onActivate={vi.fn()}
        onPreview={vi.fn()}
        onToggle={vi.fn()}
        onLifecycle={vi.fn()}
      />,
    ));
  }

  function menuItems(): string[] {
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Actions for product-front.webp"]')!;
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    });
    return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "");
  }

  it("says how many places use a file", () => {
    render("ready", { usageCount: 2 });
    expect(host.textContent).toContain("Used in 2 places");
    render("ready", { usageCount: 1 });
    expect(host.textContent).toContain("Used in 1 place");
    render("ready", { usageCount: 0 });
    expect(host.textContent).not.toContain("Used in");
  });

  it("hides Delete permanently in Trash while the file is used, and says why", () => {
    render("trash", { status: "trashed", usageCount: 1 });
    expect(host.textContent).toContain("In use, can't be deleted");
    expect(menuItems()).toEqual(["Restore"]);
  });

  it("keeps a file shown on past orders", () => {
    render("trash", { status: "trashed", keptForOrders: true });
    expect(host.textContent).toContain("Kept for past orders");
    expect(menuItems()).toEqual(["Restore"]);
  });

  it("offers Delete permanently for an unused file in Trash", () => {
    render("trash", { status: "trashed" });
    expect(menuItems()).toEqual(["Restore", "Delete permanently"]);
  });
});
