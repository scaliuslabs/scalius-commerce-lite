// @vitest-environment happy-dom

import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverTableFeatures, useTable, type ColumnDef, type SortingState } from "./table-config";
import { useColumnLayout } from "./column-layout";
import { DataTableColumnMenu } from "./DataTableColumnMenu";
import { TableSortMenu } from "./DataTableSortMenu";
import { dataColumns } from "./data-columns";

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
      <TableSortMenu table={table} />
      <DataTableColumnMenu table={table} layout={layout} />
      <p data-testid="columns">{layout.visible.map((column) => column.id).join(",")}</p>
      <p data-testid="sorting">{sorting.map((sort) => `${sort.id}:${sort.desc ? "desc" : "asc"}`).join(",")}</p>
    </div>
  );
}

vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (amount: number) => `৳${amount}`, code: "BDT" }) }));

/** A list with apps' data-backed columns and a stand-in for two of its own. */
function AppColumnsHarness({ width }: { width: number }) {
  const columns = useMemo<ColumnDef<Variant, unknown>[]>(() => [
    { accessorKey: "name", header: "Product", meta: { primary: true, minWidth: 200 } },
    { accessorKey: "sku", header: "SKU", meta: { priority: 92, minWidth: 140 }, enableSorting: false },
    { accessorKey: "vendor", header: "Vendor", meta: { priority: 90, minWidth: 140 }, enableSorting: false },
    { id: "skuVendor", header: "SKU · Vendor", meta: { priority: 92, minWidth: 150, combines: ["sku", "vendor"] }, cell: () => "…", enableSorting: false },
    ...dataColumns<Variant>([
      { id: "app.loyalty.points", label: "Points", kind: "number", value: () => 1200 },
      { id: "app.wallet.balance", label: "Wallet balance", kind: "money", priority: 30, value: () => 500 },
    ]),
  ], []);
  const table = useTable({
    features: serverTableFeatures,
    data,
    columns,
    getRowId: (row) => row.id,
    state: { pagination: { pageIndex: 0, pageSize: 20 } },
  });
  const layout = useColumnLayout(table, "apps", width);
  return (
    <div>
      <DataTableColumnMenu table={table} layout={layout} />
      <p data-testid="columns">{layout.visible.map((column) => column.id).join(",")}</p>
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
    await act(async () => button("Columns")!.click());
    // The draggable column list loads when the menu opens.
    for (let attempt = 0; attempt < 50 && !document.querySelector("[data-column-handle]"); attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  };
  // Sorting has its own menu (T2): the field, then the direction.
  const openSortMenu = async () => {
    await act(async () => button("Sort by")!.click());
    for (let attempt = 0; attempt < 50 && !document.querySelector("#table-sort-default"); attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
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
    await openSortMenu();
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
    await openSortMenu();
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

  it("shows, hides and moves apps' data-backed columns like the list's own", async () => {
    await act(async () => root.render(<AppColumnsHarness width={2000} />));
    expect(shown()).toBe("name,sku,vendor,app.loyalty.points,app.wallet.balance");
    await openMenu();
    // The stand-in is not a menu row: it follows the columns it combines.
    expect(document.querySelector('[data-column-handle="skuVendor"]')).toBeNull();
    expect(button("Show Points")!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Show Points")!.click());
    expect(shown()).toBe("name,sku,vendor,app.wallet.balance");
    // Up past the hidden Points, then past Vendor.
    for (let step = 0; step < 2; step += 1) {
      await act(async () => {
        document.querySelector<HTMLElement>('[data-column-handle="app.wallet.balance"]')!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      });
    }
    expect(shown()).toBe("name,sku,app.wallet.balance,vendor");
  });

  it("steps apps' columns aside first, then folds two columns into their stand-in", async () => {
    // 200 + 140 + 140 + 92 + 132 = 704px with everything.
    await act(async () => root.render(<AppColumnsHarness width={600} />));
    expect(shown()).toBe("name,sku,vendor");
    await act(async () => root.render(<AppColumnsHarness width={420} />));
    expect(shown()).toBe("name,skuVendor");
    await openMenu();
    // Folded, SKU and Vendor are still shown: neither says it was hidden to fit.
    expect(button("Show SKU")!.closest("div")!.textContent).not.toContain("Hidden to fit");
    expect(button("Show Vendor")!.closest("div")!.textContent).not.toContain("Hidden to fit");
    expect(button("Show Points")!.closest("div")!.textContent).toContain("Hidden to fit");
  });
});
