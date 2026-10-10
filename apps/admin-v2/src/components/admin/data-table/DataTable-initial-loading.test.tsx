// @vitest-environment happy-dom

import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataTableInitialCards, DataTableInitialRows } from "./DataTableInitialLoading";
import { serverTableFeatures, useTable, type ColumnDef } from "./table-config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: string; name: string; total: number }

function Rows({ rowCount, includeDragColumn = false }: { rowCount: number; includeDragColumn?: boolean }) {
  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { id: "select", header: "", cell: () => null },
    { accessorKey: "name", header: "Name", meta: { primary: true } },
    { accessorKey: "total", header: "Total", meta: { money: true } },
    { id: "actions", header: "", cell: () => null },
  ], []);
  const table = useTable({ features: serverTableFeatures, data: [], columns, getRowId: (row) => row.id, state: { pagination: { pageIndex: 0, pageSize: rowCount } } });
  return (
    <table>
      <tbody>
        <DataTableInitialRows columns={table.getAllLeafColumns()} rowCount={rowCount} density="default" hasSelect includeDragColumn={includeDragColumn} />
      </tbody>
    </table>
  );
}

describe("DataTable initial loading", () => {
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

  it("draws a whole page of skeleton rows in the real columns, at the row height, with no spinner (L2)", async () => {
    await act(async () => root.render(<Rows rowCount={50} />));

    const rows = host.querySelectorAll("tr[data-slot=skeleton]");
    expect(rows).toHaveLength(50);
    for (const row of rows) {
      expect(row.querySelectorAll("td")).toHaveLength(4);
      expect(row.getAttribute("aria-hidden")).toBe("true");
      expect(row.className).toContain("h-[calc(2lh+12px)]");
    }
    // The money column's placeholder sits at the end, as its numbers will.
    expect(rows[0]!.querySelectorAll("td")[2]!.hasAttribute("data-numeric")).toBe(true);
    expect(host.querySelector(".animate-spin")).toBeNull();
  });

  it("never draws more than 100 skeleton rows (X1)", async () => {
    await act(async () => root.render(<Rows rowCount={500} />));
    expect(host.querySelectorAll("tr[data-slot=skeleton]")).toHaveLength(100);
  });

  it("keeps the drag-handle column for sortable tables", async () => {
    await act(async () => root.render(<Rows rowCount={3} includeDragColumn />));
    const rows = host.querySelectorAll("tr[data-slot=skeleton]");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelectorAll("td")).toHaveLength(5);
    expect(rows[0]!.querySelector("td")?.className).toContain("w-[40px]");
  });

  it("draws about one screen of phone cards", async () => {
    await act(async () => root.render(<DataTableInitialCards count={50} />));
    expect(host.querySelectorAll("[data-slot=skeleton]")).toHaveLength(8);
    expect(host.querySelector(".animate-spin")).toBeNull();
  });
});
