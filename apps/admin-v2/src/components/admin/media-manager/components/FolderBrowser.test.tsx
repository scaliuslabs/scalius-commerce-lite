// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "./FolderBrowser";
import type { MediaFolder } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const folder: MediaFolder = {
  id: "folder_active",
  name: "Eid campaign",
  version: 1,
  createdAt: new Date("2026-07-21T00:00:00Z"),
  updatedAt: new Date("2026-07-21T00:00:00Z"),
  deletedAt: null,
};

function button(name: string): HTMLButtonElement | HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("button, [role='menuitem']")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Not found: ${name}`);
  return found;
}

describe("FolderBrowser", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onFolderDelete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onFolderDelete.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  function render(currentFolderId: string | null | "all") {
    act(() => root.render(
      <FolderBrowser
        folders={[folder]}
        currentFolderId={currentFolderId}
        onFolderSelect={vi.fn()}
        onFolderCreate={vi.fn()}
        onFolderRename={vi.fn()}
        onFolderDelete={onFolderDelete}
      />,
    ));
  }

  function openMenu() {
    act(() => {
      button("Folder actions").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  it("deletes the open folder only after the merchant confirms", () => {
    render("folder_active");
    openMenu();
    act(() => button("Delete folder").click());

    expect(onFolderDelete).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Delete folder 'Eid campaign'?");

    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((item) => item.textContent === "Delete folder");
    act(() => (confirm as HTMLButtonElement).click());
    expect(onFolderDelete).toHaveBeenCalledWith(folder);
  });

  it("offers only New folder when no single folder is open", () => {
    render("all");
    openMenu();
    expect(button("New folder")).toBeTruthy();
    expect(() => button("Delete folder")).toThrow();
  });
});
