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

  function render(allowManagement: boolean) {
    act(() => root.render(
      <MediaCard
        file={file}
        selected={false}
        selectionMode={false}
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
});
