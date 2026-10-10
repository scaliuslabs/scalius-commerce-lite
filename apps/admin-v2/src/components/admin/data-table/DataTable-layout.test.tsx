// @vitest-environment happy-dom

import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverTableFeatures, useTable, type ColumnDef } from "./table-config";
import { CARD_LAYOUT_BELOW, DataTable } from "./DataTable";
import { DataTableToolbar } from "./DataTableToolbar";
import { IdText } from "./cells";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Variant {
  id: string;
  name: string;
  sku: string;
  stock: number;
  vendor: string;
}

const LONG_SKU = "SCALIUS-MIXED-MEDIA-OPTI-GLOSS-EU";

let observedWidth = 1440;
const observers: Array<() => void> = [];

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(() => this.callback([{ contentRect: { width: observedWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function Harness({ empty = false }: { empty?: boolean }) {
  const columns = useMemo<ColumnDef<Variant, unknown>[]>(() => [
    { id: "select", header: "", cell: () => <span role="checkbox" aria-checked="false" /> },
    { accessorKey: "name", header: "Product", meta: { primary: true, minWidth: 200 } },
    { accessorKey: "sku", header: "SKU", meta: { priority: 80, minWidth: 140 }, cell: ({ row }) => <IdText value={row.original.sku} copy /> },
    { accessorKey: "stock", header: "Available", meta: { numeric: true, priority: 90, minWidth: 100 } },
    { accessorKey: "vendor", header: "Vendor", meta: { priority: 20, minWidth: 140, maxWidth: 220 } },
    { id: "actions", header: "", cell: () => "…" },
  ], []);
  const table = useTable({
    features: serverTableFeatures,
    data: empty ? [] : [{ id: "v1", name: "Xiaozhi Electronic Pet AI Chatbot", sku: LONG_SKU, stock: 4, vendor: "Aarong" }],
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    state: { pagination: { pageIndex: 0, pageSize: 20 } },
  });
  return (
    <DataTable
      table={table}
      isFetching={false}
      isLoading={false}
      paginate={false}
      layoutKey="layout-test"
      toolbar={<DataTableToolbar searchValue="" onSearchChange={() => {}} />}
    />
  );
}

describe("DataTable column layout", () => {
  let host: HTMLDivElement;
  let root: Root;
  const headers = () => [...host.querySelectorAll("th")].map((th) => th.textContent);
  const resize = (width: number) =>
    act(async () => {
      observedWidth = width;
      for (const notify of observers) notify();
    });

  beforeEach(() => {
    localStorage.clear();
    observers.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("measures its own container and hides the lowest-priority columns first", async () => {
    await act(async () => root.render(<Harness />));
    await resize(1440);
    expect(headers()).toEqual(["", "Product", "SKU", "Available", "Vendor", ""]);
    await resize(660);
    expect(headers()).toEqual(["", "Product", "SKU", "Available", ""]);
  });

  it("holds each heading at its column's narrowest width when no row sizes the columns", async () => {
    await act(async () => root.render(<Harness empty />));
    await resize(1440);
    const widths = [...host.querySelectorAll<HTMLElement>("th")].map((th) => th.style.getPropertyValue("--column-min"));
    expect(widths).toEqual(["40px", "200px", "140px", "100px", "140px", "48px"]);
    // With rows the content sizes the columns, as before.
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
    await resize(1440);
    expect([...host.querySelectorAll<HTMLElement>("th")].map((th) => th.style.getPropertyValue("--column-min"))).toEqual(["", "", "", "", "", ""]);
  });

  it("turns rows into cards by the table's own width, not the window's", async () => {
    await act(async () => root.render(<Harness />));
    // A wide window, but a narrow container (a tablet with the sidebar open).
    await resize(CARD_LAYOUT_BELOW - 1);
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("[data-data-table-results] .divide-y")).not.toBeNull();
    await resize(CARD_LAYOUT_BELOW);
    expect(host.querySelector("table")).not.toBeNull();
  });

  it("puts the column menu in the toolbar and marks the columns that pin and align", async () => {
    await act(async () => root.render(<Harness />));
    await resize(1440);
    // One toolbar (T2): the sort menu, then the columns menu.
    expect(host.querySelector('button[aria-label="Columns"]')).not.toBeNull();
    const cells = [...host.querySelectorAll("tbody td")];
    // A start-aligned column after a number keeps 24px from it (T6).
    expect(cells[4]?.hasAttribute("data-after-numeric")).toBe(true);
    expect(cells[2]?.hasAttribute("data-after-numeric")).toBe(false);
    // Every row has its density's one height (T3).
    for (const row of host.querySelectorAll("tbody tr")) expect(row.className).toContain("h-[calc(2lh+12px)]");
    expect(cells[0]?.getAttribute("data-pin")).toBe("select");
    expect(cells[1]?.getAttribute("data-pin")).toBe("primary");
    expect(cells[1]?.hasAttribute("data-after-select")).toBe(true);
    expect(cells[3]?.hasAttribute("data-numeric")).toBe(true);
    expect(cells.at(-1)?.getAttribute("data-pin")).toBe("actions");
    // The SKU never breaks: one line, full value on hover, a named copy button.
    const sku = host.querySelector(`[title="${LONG_SKU}"]`);
    expect(sku?.className).toContain("whitespace-nowrap");
    expect(sku?.className).toContain("truncate");
    expect(host.querySelector(`button[aria-label="Copy ${LONG_SKU}"]`)).not.toBeNull();
  });

  it("caps a column with maxWidth on its header and every cell", async () => {
    await act(async () => root.render(<Harness />));
    await resize(1440);
    const vendorHead = [...host.querySelectorAll("th")].find((th) => th.textContent === "Vendor")!;
    const vendorCell = [...host.querySelectorAll("tbody td")].find((td) => td.textContent === "Aarong")!;
    for (const cell of [vendorHead, vendorCell]) {
      expect(cell.hasAttribute("data-capped")).toBe(true);
      expect((cell as HTMLElement).style.getPropertyValue("--column-max")).toBe("220px");
    }
    // The header keeps its own width variable beside the cap.
    expect(vendorHead.style.getPropertyValue("--column-width")).not.toBe("");
    const sku = [...host.querySelectorAll("tbody td")].find((td) => td.textContent?.includes(LONG_SKU))!;
    expect(sku.hasAttribute("data-capped")).toBe(false);
  });
});
