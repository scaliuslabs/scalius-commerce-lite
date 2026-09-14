// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmptyState } from "./EmptyState";
import {
  IndexTable,
  indexTablePageCount,
  type IndexTableColumn,
} from "./IndexTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
  name: string;
  total: string;
}

const rows: Row[] = [
  { id: "ord_1", name: "Ayesha", total: "1,200" },
  { id: "ord_2", name: "Rafi", total: "450" },
  { id: "ord_3", name: "Nadia", total: "980" },
];

const columns: IndexTableColumn<Row>[] = [
  { id: "name", header: "Customer", cell: (row) => row.name, sortable: true },
  { id: "total", header: "Total", align: "end", cell: (row) => row.total },
];

describe("indexTablePageCount", () => {
  it("never reports fewer than one page", () => {
    expect(indexTablePageCount(0, 25)).toBe(1);
    expect(indexTablePageCount(25, 25)).toBe(1);
    expect(indexTablePageCount(26, 25)).toBe(2);
    expect(indexTablePageCount(120, 25)).toBe(5);
    expect(indexTablePageCount(120, 0)).toBe(1);
  });
});

describe("IndexTable", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  function bodyRows() {
    return Array.from(host.querySelectorAll('[data-testid="index-table-row"]'));
  }
  function checkboxes() {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'));
  }

  it("renders one row per item with the column cells", async () => {
    await render(<IndexTable items={rows} columns={columns} getRowId={(row) => row.id} />);

    expect(bodyRows()).toHaveLength(3);
    expect(bodyRows()[0].getAttribute("data-row-id")).toBe("ord_1");
    expect(bodyRows()[0].textContent).toContain("Ayesha");
    expect(bodyRows()[0].textContent).toContain("1,200");
    expect(host.querySelector("table")!.getAttribute("aria-label")).toBe("Results");
    expect(host.querySelector('[data-testid="index-table-loading-row"]')).toBeNull();
  });

  it("shows skeleton rows while the first page loads, and no empty state", async () => {
    await render(
      <IndexTable items={[]} columns={columns} getRowId={(row) => row.id} loading loadingRowCount={4} />,
    );

    expect(host.querySelectorAll('[data-testid="index-table-loading-row"]')).toHaveLength(4);
    expect(host.querySelector('[data-testid="empty-state"]')).toBeNull();
    expect(host.querySelector(".animate-spin")).toBeNull();
    expect(host.querySelector("table")!.getAttribute("aria-busy")).toBe("true");
  });

  it("replaces the table with the empty state when there is nothing to list", async () => {
    await render(
      <IndexTable
        items={[]}
        columns={columns}
        getRowId={(row) => row.id}
        empty={<EmptyState heading="No orders yet" body="Orders appear here after checkout." />}
      />,
    );

    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector('[data-testid="empty-state"]')!.textContent).toContain(
      "No orders yet",
    );
  });

  it("falls back to a default empty state", async () => {
    await render(<IndexTable items={[]} columns={columns} getRowId={(row) => row.id} />);

    expect(host.querySelector('[data-testid="empty-state"]')!.textContent).toContain(
      "Nothing here yet",
    );
  });

  it("reports row selection and select-all through the callback", async () => {
    const onSelectionChange = vi.fn();
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        selectable
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    );

    const [selectAll, firstRow] = checkboxes();
    expect(selectAll.getAttribute("aria-label")).toBe("Select all rows");

    await act(async () => firstRow.click());
    expect(onSelectionChange).toHaveBeenLastCalledWith(["ord_1"]);

    await act(async () => selectAll.click());
    expect(onSelectionChange).toHaveBeenLastCalledWith(["ord_1", "ord_2", "ord_3"]);
  });

  it("clears only the listed rows and marks partial selection", async () => {
    const onSelectionChange = vi.fn();
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        selectable
        selectedIds={["ord_1", "ord_2"]}
        onSelectionChange={onSelectionChange}
        bulkActions={<button type="button">Fulfil</button>}
      />,
    );

    expect(checkboxes()[0].getAttribute("data-state")).toBe("indeterminate");
    expect(host.querySelector('[data-testid="index-table-bulk-actions"]')!.textContent).toContain(
      "2 selected",
    );
    expect(bodyRows()[0].getAttribute("aria-selected")).toBe("true");
    expect(bodyRows()[2].getAttribute("aria-selected")).toBe("false");

    // Unchecking a selected row removes just that row.
    await act(async () => checkboxes()[1].click());
    expect(onSelectionChange).toHaveBeenLastCalledWith(["ord_2"]);
  });

  it("hides the bulk action bar while nothing is selected", async () => {
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        selectable
        selectedIds={[]}
        onSelectionChange={vi.fn()}
        bulkActions={<button type="button">Fulfil</button>}
      />,
    );

    expect(host.querySelector('[data-testid="index-table-bulk-actions"]')).toBeNull();
  });

  it("makes clickable rows keyboard reachable", async () => {
    const onRowClick = vi.fn();
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );

    const [first] = bodyRows();
    expect(first.getAttribute("tabindex")).toBe("0");

    await act(async () => {
      first.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);

    await act(async () => (first as HTMLElement).click());
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it("leaves rows out of the tab order when they are not clickable", async () => {
    await render(<IndexTable items={rows} columns={columns} getRowId={(row) => row.id} />);
    expect(bodyRows()[0].getAttribute("tabindex")).toBeNull();
  });

  it("keeps row action clicks out of the row click handler", async () => {
    const onRowClick = vi.fn();
    const onEdit = vi.fn();
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        onRowClick={onRowClick}
        rowActions={(row) => (
          <button type="button" onClick={onEdit}>
            Edit {row.id}
          </button>
        )}
      />,
    );

    const edit = Array.from(host.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("Edit ord_1"),
    )!;
    await act(async () => edit.click());
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("exposes sort state on the header and toggles direction", async () => {
    const onSortChange = vi.fn();
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        sort={{ columnId: "name", direction: "asc" }}
        onSortChange={onSortChange}
      />,
    );

    const headers = Array.from(host.querySelectorAll("th"));
    expect(headers[0].getAttribute("aria-sort")).toBe("ascending");
    // Non-sortable columns do not claim a sort state.
    expect(headers[1].getAttribute("aria-sort")).toBeNull();

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="index-table-sort-name"]')!.click(),
    );
    expect(onSortChange).toHaveBeenCalledWith("name", "desc");
  });

  it("keeps the header sticky by default and lets it be turned off", async () => {
    await render(<IndexTable items={rows} columns={columns} getRowId={(row) => row.id} />);
    expect(host.querySelector("thead")!.className).toContain("sticky");

    await render(
      <IndexTable items={rows} columns={columns} getRowId={(row) => row.id} stickyHeader={false} />,
    );
    expect(host.querySelector("thead")!.className).not.toContain("sticky");
  });

  it("pages through a server-side list from the footer", async () => {
    const onPageChange = vi.fn();
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        pagination={{ page: 2, pageSize: 25, total: 120, onPageChange }}
      />,
    );

    const pager = host.querySelector<HTMLElement>('[data-testid="index-table-pagination"]')!;
    expect(pager.getAttribute("aria-label")).toBe("Pagination");
    expect(
      host.querySelector('[data-testid="index-table-pagination-range"]')!.textContent,
    ).toBe("26\u201350 of 120 items");
    expect(pager.textContent).toContain("Page 2 of 5");

    const previous = host.querySelector<HTMLButtonElement>(
      '[data-testid="index-table-pagination-previous"]',
    )!;
    const next = host.querySelector<HTMLButtonElement>(
      '[data-testid="index-table-pagination-next"]',
    )!;
    expect(previous.disabled).toBe(false);
    await act(async () => next.click());
    expect(onPageChange).toHaveBeenCalledWith(3);
    await act(async () => previous.click());
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });

  it("locks the pager at the ends and while a page is in flight", async () => {
    const onPageChange = vi.fn();
    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        pagination={{ page: 1, pageSize: 25, total: 3, onPageChange }}
      />,
    );

    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="index-table-pagination-previous"]')!
        .disabled,
    ).toBe(true);
    // One page of results: there is nowhere to go in either direction.
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="index-table-pagination-next"]')!
        .disabled,
    ).toBe(true);

    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        pagination={{ page: 2, pageSize: 25, total: 120, onPageChange, disabled: true }}
      />,
    );
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="index-table-pagination-next"]')!
        .disabled,
    ).toBe(true);
  });

  it("keeps the footer note above the pager and renders neither by default", async () => {
    await render(<IndexTable items={rows} columns={columns} getRowId={(row) => row.id} />);
    expect(host.querySelector('[data-testid="index-table-pagination"]')).toBeNull();

    await render(
      <IndexTable
        items={rows}
        columns={columns}
        getRowId={(row) => row.id}
        footer={<p>3 saved rates</p>}
        pagination={{ page: 1, pageSize: 25, total: 3, onPageChange: vi.fn() }}
      />,
    );
    const footer = host.querySelector('[data-testid="index-table-pagination"]')!.parentElement!;
    expect(footer.textContent).toContain("3 saved rates");
    expect(footer.firstElementChild!.textContent).toBe("3 saved rates");
  });

  it("reads the first column as the mobile card title and labels the rest", async () => {
    await render(
      <IndexTable
        items={rows}
        columns={[
          ...columns,
          { id: "hidden", header: "Internal", cell: () => "x", hideOnMobile: true },
        ]}
        getRowId={(row) => row.id}
        rowActions={() => <button type="button">Open menu</button>}
      />,
    );

    const row = bodyRows()[0];
    // The card title carries no "Customer" label: it is the heading of the card.
    const labels = Array.from(row.querySelectorAll('span[aria-hidden="true"]')).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["Total"]);

    const primary = row.querySelector<HTMLElement>('[data-primary-cell="true"]')!;
    expect(primary.textContent).toBe("Ayesha");
    expect(primary.className).toContain("max-sm:text-left");
    expect(primary.className).toContain("max-sm:font-medium");
    // It keeps clear of the actions button pinned to the card's top-right.
    expect(primary.className).toContain("max-sm:pr-11");

    const actions = row.querySelector<HTMLElement>('[data-testid="index-table-row-actions"]')!;
    expect(actions.className).toContain("max-sm:absolute");
    expect(actions.className).toContain("max-sm:right-2");
    expect(actions.className).toContain("max-sm:top-2");
    expect(row.className).toContain("max-sm:relative");
  });

  it("keeps the mobile card title full width when the row has no actions", async () => {
    await render(<IndexTable items={rows} columns={columns} getRowId={(row) => row.id} />);

    const primary = bodyRows()[0].querySelector<HTMLElement>('[data-primary-cell="true"]')!;
    expect(primary.className).toContain("max-sm:pr-0");
    expect(bodyRows()[0].querySelector('[data-testid="index-table-row-actions"]')).toBeNull();
  });

  it("promotes the first visible column when the leading column is mobile-hidden", async () => {
    await render(
      <IndexTable
        items={rows}
        columns={[
          { id: "hidden", header: "Internal", cell: () => "x", hideOnMobile: true },
          ...columns,
        ]}
        getRowId={(row) => row.id}
      />,
    );

    const primary = bodyRows()[0].querySelector<HTMLElement>('[data-primary-cell="true"]')!;
    expect(primary.textContent).toBe("Ayesha");
  });
});
