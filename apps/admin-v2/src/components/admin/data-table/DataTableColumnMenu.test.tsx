// @vitest-environment happy-dom

import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverTableFeatures, useTable, type ColumnDef, type SortingState } from "./table-config";
import { useColumnLayout } from "./column-layout";
import { DataTableColumnMenu } from "./DataTableColumnMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Variant {
  id: string;
  name: string;
  sku: string;
  stock: number;
  vendor: string;
}

const data: Variant[] = [{ id: "v1", name: "Panjabi", sku: "SCALIUS-MIXED-MEDIA-OPTI-GLOSS-EU", stock: 4, vendor: "Aarong" }];

function Harness({ width }: { width: number }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = useMemo<ColumnDef<Variant, unknown>[]>(() => [
    { id: "select", header: "", cell: () => "☐", enableSorting: false },
    { accessorKey: "name", header: "Product", meta: { primary: true, minWidth: 200 } },
    { accessorKey: "sku", header: "SKU", meta: { priority: 80, minWidth: 140 }, enableSorting: false },
    { accessorKey: "stock", header: "Available", meta: { numeric: true, priority: 90, minWidth: 100 } },
    { accessorKey: "vendor", header: "Vendor", meta: { priority: 20, minWidth: 140 }, enableSorting: false },
    { id: "actions", header: "", cell: () => "…", enableSorting: false },
  ], []);
  const table = useTable({
    features: serverTableFeatures,
    data,
    columns,
    getRowId: (row) => row.id,
    state: { sorting, pagination: { pageIndex: 0, pageSize: 20 } },
    onSortingChange: (updater) => setSorting((current) => (typeof updater === "function" ? updater(current) : updater)),
    manualSorting: true,
  });
  const layout = useColumnLayout(table, "inventory", width);
  return (
    <div>
      <DataTableColumnMenu table={table} layout={layout} />
      <p data-testid="columns">{layout.visible.map((column) => column.id).join(",")}</p>
      <p data-testid="sorting">{sorting.map((sort) => `${sort.id}:${sort.desc ? "desc" : "asc"}`).join(",")}</p>
    </div>
  );
}

describe("column menu and width-aware columns", () => {
  let host: HTMLDivElement;
  let root: Root;
  const shown = () => document.querySelector("[data-testid=columns]")!.textContent;
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name);
  const render = (width: number) => act(async () => root.render(<Harness width={width} />));
  const openMenu = async () => {
    await act(async () => button("Sort and columns")!.click());
  };

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("hides and shows a column with its eye, remembers it for the list, and resets", async () => {
    await render(1440);
    expect(shown()).toBe("select,name,sku,stock,vendor,actions");
    await openMenu();

    // The title column is always shown: no eye to hide it.
    expect(button("Show Product")).toBeUndefined();
    // One name per column; aria-pressed says whether it is shown.
    expect(button("Show Vendor")!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Show Vendor")!.click());
    expect(button("Show Vendor")!.getAttribute("aria-pressed")).toBe("false");
    expect(shown()).toBe("select,name,sku,stock,actions");
    expect(JSON.parse(localStorage.getItem("scalius.table.inventory")!)).toMatchObject({ hidden: ["vendor"] });

    // A new visit to the list keeps the choice.
    act(() => root.unmount());
    root = createRoot(host);
    await render(1440);
    expect(shown()).toBe("select,name,sku,stock,actions");

    await openMenu();
    await act(async () => button("Show Vendor")!.click());
    expect(shown()).toBe("select,name,sku,stock,vendor,actions");
    await act(async () => button("Reset to default")!.click());
    expect(localStorage.getItem("scalius.table.inventory")).toBeNull();
  });

  it("reorders columns from the keyboard on the drag handle", async () => {
    await render(1440);
    await openMenu();
    const handle = document.querySelector<HTMLElement>('[data-column-handle="stock"]')!;
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(shown()).toBe("select,name,stock,sku,vendor,actions");
    expect(JSON.parse(localStorage.getItem("scalius.table.inventory")!).order).toEqual(["name", "stock", "sku", "vendor"]);
  });

  it("keeps the title column first: it has no handle and nothing moves above it", async () => {
    await render(1440);
    await openMenu();
    expect(document.querySelector('[data-column-handle="name"]')).toBeNull();
    expect(document.querySelector('[data-column-fixed="name"]')?.textContent).toContain("Product");
    const up = async (id: string) =>
      act(async () => {
        document.querySelector<HTMLElement>(`[data-column-handle="${id}"]`)!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      });
    await up("sku");
    await up("sku");
    expect(shown()).toBe("select,name,sku,stock,vendor,actions");
    await up("stock");
    await up("stock");
    expect(shown()).toBe("select,name,stock,sku,vendor,actions");
  });

  it("puts the title column back first when a saved order has it elsewhere", async () => {
    localStorage.setItem("scalius.table.inventory", JSON.stringify({ order: ["stock", "vendor", "name", "sku"], hidden: [] }));
    await render(1440);
    expect(shown()).toBe("select,name,stock,vendor,sku,actions");
    await openMenu();
    const rows = [...document.querySelectorAll("[data-column-fixed], [data-column-handle]")].map(
      (node) => node.getAttribute("data-column-fixed") ?? node.getAttribute("data-column-handle"),
    );
    expect(rows).toEqual(["name", "stock", "vendor", "sku"]);
  });

  it("sorts by the chosen field and direction", async () => {
    await render(1440);
    await openMenu();
    await act(async () => document.querySelector<HTMLElement>("#table-sort-stock")!.click());
    expect(document.querySelector("[data-testid=sorting]")!.textContent).toBe("stock:asc");
    await act(async () => button("Descending")!.click());
    expect(document.querySelector("[data-testid=sorting]")!.textContent).toBe("stock:desc");
  });

  it("steps low-priority columns aside as the container narrows and says how many", async () => {
    // Needs 40 + 200 + 140 + 100 + 140 + 56 = 676px.
    await render(700);
    expect(shown()).toBe("select,name,sku,stock,vendor,actions");
    await render(560);
    expect(shown()).toBe("select,name,sku,stock,actions");
    await render(420);
    expect(shown()).toBe("select,name,stock,actions");
    await openMenu();
    // Each column stepped aside says so in its own row; it is still shown by choice.
    const row = (name: string) => button(`Show ${name}`)!.closest("div")!;
    expect(row("SKU").textContent).toContain("Hidden to fit this width");
    expect(row("Vendor").textContent).toContain("Hidden to fit this width");
    expect(row("Available").textContent).not.toContain("Hidden to fit");
    expect(button("Show Vendor")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("Show Vendor")!.getAttribute("aria-describedby")).toBe("column-squeezed-vendor");
  });

  it("lists the list's default order as a sort choice, selected while no sort is chosen", async () => {
    await render(1440);
    await openMenu();
    const choice = document.querySelector<HTMLElement>("#table-sort-default")!;
    expect(choice.getAttribute("aria-checked")).toBe("true");
    await act(async () => document.querySelector<HTMLElement>("#table-sort-stock")!.click());
    expect(choice.getAttribute("aria-checked")).toBe("false");
    await act(async () => choice.click());
    expect(document.querySelector("[data-testid=sorting]")!.textContent).toBe("");
  });

  it("grows to the height the screen allows instead of the popover's 24rem", async () => {
    await render(1440);
    await openMenu();
    const panel = document.querySelector<HTMLElement>("[data-slot=column-menu-body]")!.parentElement!;
    expect(panel.className).toContain("max-h-(--radix-popover-content-available-height)");
    expect(panel.className).not.toContain("24rem");
  });
});
