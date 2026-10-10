// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataTableToolbar, IndexBulkBar } from "./DataTableToolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DataTableToolbar", () => {
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

  const render = (selected: number, onClear = () => undefined) =>
    act(async () => root.render(
      <div data-slot="index-table">
        <DataTableToolbar
          searchValue="panjabi"
          onSearchChange={() => undefined}
          filters={<label>Category<input /></label>}
          filterCount={1}
          onClearFilters={onClear}
          bulkBar={selected > 0 ? (
            <IndexBulkBar status={<span>{selected} selected</span>} actions={<button type="button">Set as draft</button>} onClear={() => undefined} />
          ) : undefined}
        />
      </div>,
    ));

  it("swaps the toolbar for a sticky bulk bar while rows are selected, keeping the typed search (T10)", async () => {
    await render(0);
    const toolbar = host.querySelector<HTMLElement>("[data-bulk-hidden], div.px-2")!;
    expect(host.querySelector("[data-slot=bulk-bar]")).toBeNull();
    expect(toolbar.hasAttribute("data-bulk-hidden")).toBe(false);

    await render(2);
    const bar = host.querySelector<HTMLElement>("[data-slot=bulk-bar]")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.textContent).toContain("Set as draft");
    // Sticky with its own border; the actions scroll sideways instead of wrapping.
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("border-b");
    expect(bar.querySelector(".flex-nowrap")).not.toBeNull();
    expect(toolbar.hasAttribute("data-bulk-hidden")).toBe(true);
    expect(host.querySelector("input")!.value).toBe("panjabi");
    // The table's sticky header sits under the bar.
    expect(host.querySelector<HTMLElement>("[data-slot=index-table]")!.style.getPropertyValue("--index-sticky-top")).toMatch(/px$/);

    await render(0);
    expect(host.querySelector("[data-slot=bulk-bar]")).toBeNull();
    expect(toolbar.hasAttribute("data-bulk-hidden")).toBe(false);
    expect(host.querySelector<HTMLElement>("[data-slot=index-table]")!.style.getPropertyValue("--index-sticky-top")).toBe("");
  });

  it("opens the filters in a panel under the toolbar, with the count and Clear filters (T2)", async () => {
    const onClear = vi.fn();
    await render(0, onClear);
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Filters"))!;
    expect(button.textContent).toBe("Filters (1)");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = host.querySelector(`#${CSS.escape(button.getAttribute("aria-controls")!)}`)!;
    expect(panel.textContent).toContain("Category");
    await act(async () => [...panel.querySelectorAll("button")].find((node) => node.textContent?.includes("Clear filters"))!.click());
    expect(onClear).toHaveBeenCalledOnce();
  });
  it("closes filters with Escape and returns focus without clearing the filter", async () => {
    const clear = vi.fn();
    await render(0, clear);
    const trigger = host.querySelector<HTMLButtonElement>("button[aria-controls]")!;
    await act(async () => trigger.click());
    const field = host.querySelector<HTMLInputElement>("[role=group] input")!;
    field.focus();
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector("[role=group]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(clear).not.toHaveBeenCalled();
  });

});
