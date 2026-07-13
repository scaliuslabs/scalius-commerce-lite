// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFilterBar } from "./MediaFilterBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const filters = {
  search: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  view: "ready",
} as const;

function buttonByName(host: HTMLElement, name: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === name);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`);
  return button;
}

describe("MediaFilterBar selection controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onSelectAll = vi.fn();

  function Harness({ persistentSelection = false }: { persistentSelection?: boolean }) {
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedCount, setSelectedCount] = useState(0);

    return (
      <MediaFilterBar
        capability="image"
        filters={filters}
        view="ready"
        selectionMode={selectionMode}
        selectedCount={selectedCount}
        visibleCount={5}
        persistentSelection={persistentSelection}
        folders={[]}
        isMutating={false}
        onSearch={vi.fn()}
        onFiltersChange={vi.fn()}
        onUpload={vi.fn()}
        onBeginSelection={() => setSelectionMode(true)}
        onSelectAll={() => {
          onSelectAll();
          setSelectedCount(5);
        }}
        onClearSelection={() => {
          setSelectedCount(0);
          setSelectionMode(persistentSelection);
        }}
        onMove={vi.fn()}
        onLifecycle={vi.fn()}
        onAddSelected={persistentSelection ? vi.fn() : undefined}
      />
    );
  }

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onSelectAll.mockReset();
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("enters selection mode without selecting every visible asset", () => {
    act(() => buttonByName(host, "Select").click());

    expect(onSelectAll).not.toHaveBeenCalled();
    expect(host.textContent).toContain("0 selected");
    expect(buttonByName(host, "Select all shown")).toBeTruthy();
    expect(buttonByName(host, "Cancel")).toBeTruthy();
  });

  it("selects every visible asset only through the explicit action", () => {
    act(() => buttonByName(host, "Select").click());
    act(() => buttonByName(host, "Select all shown").click());

    expect(onSelectAll).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("5 selected");
    expect(host.textContent).not.toContain("Select all shown");
    expect(buttonByName(host, "Clear")).toBeTruthy();
  });

  it("keeps multi-file pickers in truthful selection mode after clearing", () => {
    act(() => root.render(<Harness persistentSelection />));
    act(() => buttonByName(host, "Select").click());

    expect(host.textContent).toContain("0 selected");
    expect(host.textContent).not.toContain("Cancel");
    expect(buttonByName(host, "Add 0").disabled).toBe(true);

    act(() => buttonByName(host, "Select all shown").click());
    act(() => buttonByName(host, "Clear").click());

    expect(host.textContent).toContain("0 selected");
    expect(buttonByName(host, "Select all shown")).toBeTruthy();
    expect(buttonByName(host, "Add 0").disabled).toBe(true);
  });

  it("separates selection commands into an accessible bulk-action toolbar", () => {
    act(() => buttonByName(host, "Select").click());

    const toolbar = host.querySelector('[role="toolbar"][aria-label="Selected asset actions"]');
    expect(toolbar).toBeTruthy();
    expect(toolbar?.textContent).toContain("Shift-click to select a range");
    expect(toolbar?.textContent).toContain("0 selected");
  });
});
