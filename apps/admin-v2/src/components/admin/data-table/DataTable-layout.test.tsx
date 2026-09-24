// @vitest-environment happy-dom

import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverTableFeatures, useTable, type ColumnDef } from "./table-config";
import { DataTable } from "./DataTable";
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

function Harness() {
  const columns = useMemo<ColumnDef<Variant, unknown>[]>(() => [
    { id: "select", header: "", cell: () => <span role="checkbox" aria-checked="false" /> },
    { accessorKey: "name", header: "Product", meta: { primary: true, minWidth: 200 } },
    { accessorKey: "sku", header: "SKU", meta: { priority: 80, minWidth: 140 }, cell: ({ row }) => <IdText value={row.original.sku} copy /> },
    { accessorKey: "stock", header: "Available", meta: { numeric: true, priority: 90, minWidth: 100 } },
    { accessorKey: "vendor", header: "Vendor", meta: { priority: 20, minWidth: 140 } },
    { id: "actions", header: "", cell: () => "…" },
  ], []);
  const table = useTable({
    features: serverTableFeatures,
    data: [{ id: "v1", name: "Xiaozhi Electronic Pet AI Chatbot", sku: LONG_SKU, stock: 4, vendor: "Aarong" }],
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
    await resize(560);
    expect(headers()).toEqual(["", "Product", "SKU", "Available", ""]);
    await resize(400);
    expect(headers()).toEqual(["", "Product", "Available", ""]);
  });

  it("puts the column menu in the toolbar and marks the columns that pin and align", async () => {
    await act(async () => root.render(<Harness />));
    await resize(1440);
    expect(host.querySelector('button[aria-label="Sort and columns"]')).not.toBeNull();
    const cells = [...host.querySelectorAll("tbody td")];
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
});
