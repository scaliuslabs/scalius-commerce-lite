// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "./FolderBrowser";
import type { MediaFolder } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const folders: MediaFolder[] = [
  {
    id: "folder_active",
    name: "A long active folder",
    version: 1,
    createdAt: new Date("2026-07-21T00:00:00Z"),
    updatedAt: new Date("2026-07-21T00:00:00Z"),
    deletedAt: null,
  },
];

describe("FolderBrowser compact rail", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("keeps the complete current folder group visible after route restoration", () => {
    act(() => root.render(
      <FolderBrowser
        folders={folders}
        currentFolderId="folder_active"
        onFolderSelect={vi.fn()}
        onFolderCreate={vi.fn()}
        onFolderRename={vi.fn()}
        onFolderDelete={vi.fn()}
      />,
    ));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    const currentButton = host.querySelector('button[aria-current="page"]');
    expect(currentButton?.textContent).toContain("A long active folder");
    expect(currentButton?.parentElement?.querySelector('button[aria-label="Actions for A long active folder"]')).toBeTruthy();
  });
});
