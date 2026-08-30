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

describe("FolderBrowser layout", () => {
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

  it("keeps folder actions from shrinking behind long labels", () => {
    act(() => root.render(
      <FolderBrowser
        folders={folders}
        currentFolderId="all"
        onFolderSelect={vi.fn()}
        onFolderCreate={vi.fn()}
        onFolderRename={vi.fn()}
        onFolderDelete={vi.fn()}
      />,
    ));

    const actionButtons = host.querySelectorAll(
      'button[aria-label="Actions for A long active folder"]',
    );

    expect(actionButtons).toHaveLength(2);
    actionButtons.forEach((button) => {
      expect(button.classList.contains("shrink-0")).toBe(true);
    });

    const desktopNavigation = host.querySelectorAll(
      'nav[aria-label="Media folders"]',
    )[1];
    const desktopAction = desktopNavigation?.querySelector(
      'button[aria-label="Actions for A long active folder"]',
    );

    expect(desktopNavigation?.classList.contains("overflow-y-auto")).toBe(true);
    expect(desktopAction?.parentElement?.classList.contains("min-w-0")).toBe(true);
    expect(desktopAction?.parentElement?.classList.contains("w-full")).toBe(true);
  });
});
