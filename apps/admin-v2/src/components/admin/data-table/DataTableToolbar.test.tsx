// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataTableToolbar } from "./DataTableToolbar";

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

  const render = (selectedCount: number) =>
    act(async () => root.render(
      <DataTableToolbar
        searchValue="panjabi"
        onSearchChange={() => undefined}
        selectedCount={selectedCount}
        filters={<button type="button">All categories</button>}
        bulkActions={<><span>2 selected</span><button type="button">Set as draft</button></>}
      />,
    ));

  it("swaps the search row for the bulk bar at the same height, keeping the typed search", async () => {
    await render(0);
    const searchRow = host.querySelector<HTMLInputElement>("input")!.closest("div[class*='flex-wrap']")!;
    expect(host.querySelector("[data-slot=bulk-bar]")).toBeNull();
    expect(searchRow.hasAttribute("data-bulk-hidden")).toBe(false);

    await render(2);
    const bar = host.querySelector<HTMLElement>("[data-slot=bulk-bar]")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.textContent).toContain("Set as draft");
    // One row that scrolls sideways rather than wrapping onto a second line;
    // as tall as the search field (44px on phones, 36px from sm).
    expect(bar.className).toContain("flex-nowrap");
    expect(bar.className).toContain("min-h-11");
    expect(bar.className).toContain("sm:min-h-9");
    expect(searchRow.hasAttribute("data-bulk-hidden")).toBe(true);
    expect(host.querySelector("input")!.value).toBe("panjabi");

    await render(0);
    expect(host.querySelector("[data-slot=bulk-bar]")).toBeNull();
    expect(searchRow.hasAttribute("data-bulk-hidden")).toBe(false);
  });
});
