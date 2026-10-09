// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTablePagination, type DataTableCursorPaging } from "./DataTablePagination";
import { serverTableFeatures, useTable, type ColumnDef } from "./table-config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
}

const columns: ColumnDef<Row, unknown>[] = [{ accessorKey: "id" }];

function Harness({ rows, rowCount, cursorPaging }: { rows: number; rowCount: number; cursorPaging?: DataTableCursorPaging }) {
  const table = useTable({
    features: serverTableFeatures,
    data: Array.from({ length: rows }, (_, index) => ({ id: `row_${index}` })),
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    state: { pagination: { pageIndex: 0, pageSize: 50 } },
    pageCount: Math.ceil(rowCount / 50),
    rowCount,
  });
  return <DataTablePagination table={table} cursorPaging={cursorPaging} />;
}

describe("DataTablePagination", () => {
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

  const render = (props: Parameters<typeof Harness>[0]) => act(async () => root.render(<Harness {...props} />));
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const pageInfo = (overrides: Partial<NonNullable<DataTableCursorPaging["pageInfo"]>> = {}) => ({
    hasNextPage: true,
    hasPreviousPage: true,
    startCursor: "start-cursor",
    endCursor: "end-cursor",
    ...overrides,
  });

  it("keeps numbered paging the way it was without cursors", async () => {
    await render({ rows: 50, rowCount: 120 });
    expect(host.textContent).toContain("1–50 of 120");
    expect(button("Previous").disabled).toBe(true);
    expect(button("Next").disabled).toBe(false);
    expect(host.querySelector("nav")!.getAttribute("aria-label")).toBe("Page 1 of 3");
  });

  it("reads 'A–B of N' from the page's offset when the total is exact", async () => {
    await render({ rows: 50, rowCount: 230, cursorPaging: { total: 230, offset: 100, pageInfo: pageInfo(), onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.textContent).toContain("101–150 of 230");
    expect(host.textContent).not.toContain("230+");
  });

  it("reads 'A–B of 1,000+' when the count stops at its cap", async () => {
    await render({ rows: 50, rowCount: 1_000, cursorPaging: { total: 1_000, totalIsCapped: true, offset: 0, pageInfo: pageInfo({ hasPreviousPage: false }), onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.textContent).toContain("1–50 of 1,000+");
  });

  it("says what is shown, not a range, when the page is deeper than the count reaches", async () => {
    await render({ rows: 50, rowCount: 1_000, cursorPaging: { total: 1_000, totalIsCapped: true, offset: null, pageInfo: pageInfo(), onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.textContent).toContain("50 shown, beyond the first 1,000");
  });

  it("follows the cursors: Next sends the end cursor, Previous the start cursor", async () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    await render({ rows: 50, rowCount: 400, cursorPaging: { total: 400, offset: 50, pageInfo: pageInfo(), onNext, onPrevious } });
    expect(host.querySelector("nav")!.getAttribute("aria-label")).toBe("Pagination");
    await act(async () => button("Next").click());
    await act(async () => button("Previous").click());
    expect(onNext).toHaveBeenCalledExactlyOnceWith("end-cursor");
    expect(onPrevious).toHaveBeenCalledExactlyOnceWith("start-cursor");
  });

  it("leaves Previous and Next out when everything fits on one page or the page info is unknown (T12)", async () => {
    await render({ rows: 50, rowCount: 90, cursorPaging: { total: 90, offset: 0, pageInfo: pageInfo({ hasPreviousPage: false, hasNextPage: false }), onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.querySelector("[data-slot=pagination]")).not.toBeNull();
    expect(host.querySelector("nav")).toBeNull();
    await render({ rows: 50, rowCount: 90, cursorPaging: { total: 90, offset: 0, pageInfo: undefined, onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.querySelector("nav")).toBeNull();
    // A page flagged as having a neighbour but carrying no cursor to reach it keeps that arrow disabled.
    await render({ rows: 50, rowCount: 90, cursorPaging: { total: 90, offset: 0, pageInfo: pageInfo({ endCursor: null }), onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(button("Next").disabled).toBe(true);
    expect(button("Previous").disabled).toBe(false);
  });

  it("reads the range alone for a list the API does not count", async () => {
    await render({ rows: 50, rowCount: -1, cursorPaging: { total: null, offset: 50, pageInfo: pageInfo(), onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.querySelector("[aria-live='polite']")!.textContent).toBe("51–100");
  });

  it("announces the range politely to screen readers and hides the footer for an empty list", async () => {
    await render({ rows: 5, rowCount: 5, cursorPaging: { total: 5, offset: 0, pageInfo: pageInfo({ hasPreviousPage: false, hasNextPage: false }), onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.querySelector("[aria-live='polite']")!.textContent).toBe("1–5 of 5");
    await render({ rows: 0, rowCount: 0, cursorPaging: { total: 0, offset: 0, pageInfo: undefined, onNext: vi.fn(), onPrevious: vi.fn() } });
    expect(host.querySelector("nav")).toBeNull();
  });
});
