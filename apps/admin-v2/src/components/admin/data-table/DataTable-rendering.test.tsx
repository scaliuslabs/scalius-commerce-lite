// @vitest-environment happy-dom

import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from "@tanstack/react-table";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataTableBodyRow } from "./DataTableBodyRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface TestRow {
  id: string;
  name: string;
}

const rows: TestRow[] = Array.from({ length: 100 }, (_, index) => ({
  id: `row_${index}`,
  name: `Row ${index}`,
}));

const renderCell = vi.fn();

function TableHarness({
  isFetching,
  selectedId,
}: {
  isFetching: boolean;
  selectedId?: string;
}) {
  const columns = useMemo<ColumnDef<TestRow, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        cell: ({ getValue }) => {
          renderCell();
          return String(getValue());
        },
      },
    ],
    [],
  );
  const rowSelection: RowSelectionState = selectedId
    ? { [selectedId]: true }
    : {};
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: {
      pagination: { pageIndex: 0, pageSize: 100 },
      rowSelection,
    },
    onRowSelectionChange: () => undefined,
  });

  return (
    <table data-fetching={isFetching || undefined}>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <DataTableBodyRow
            key={row.id}
            cells={row.getVisibleCells()}
            isSelected={row.getIsSelected()}
            includeDragColumn={false}
          />
        ))}
      </tbody>
    </table>
  );
}

describe("DataTable rendering", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    renderCell.mockClear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("does not rerender unchanged cells for fetch-state or unrelated selection updates", async () => {
    await act(async () => {
      root.render(<TableHarness isFetching={false} />);
    });

    expect(renderCell).toHaveBeenCalledTimes(100);

    await act(async () => {
      root.render(<TableHarness isFetching />);
    });

    expect(renderCell).toHaveBeenCalledTimes(100);
    expect(host.querySelector("table")?.dataset.fetching).toBe("true");

    await act(async () => {
      root.render(<TableHarness isFetching={false} selectedId="row_0" />);
    });

    expect(renderCell).toHaveBeenCalledTimes(101);
    expect(host.querySelector('tbody tr[data-state="selected"]')).toBeTruthy();
  });
});
