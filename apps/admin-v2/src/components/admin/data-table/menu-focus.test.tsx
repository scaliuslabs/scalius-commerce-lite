// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DataTableColumnHeader } from "./DataTableColumnHeader";
import { DataTableRowActions } from "./DataTableRowActions";
import { DataTableBodyRow, DataTableHeadCell } from "./DataTableBodyRow";
import { sortHeader } from "../resource/columns";
import { createActionsColumn, createDateColumn } from "./columns/column-factories";
import { flexRender, serverTableFeatures, useTable, type Column, type ColumnDef } from "./table-config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

async function openAndEscape() {
  const opener = host.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { opener.focus(); opener.click(); });
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
}

const headerRows = [{ id: "product_1", name: "Product" }];
const headerColumns: ColumnDef<(typeof headerRows)[number], unknown>[] = [
  { accessorKey: "name", header: sortHeader("Product"), meta: { primary: true } },
];

function HeaderHarness({ columns = headerColumns }: { columns?: typeof headerColumns }) {
  const table = useTable({ features: serverTableFeatures, data: headerRows, columns });
  const header = table.getFlatHeaders()[0]!;
  return (
    <table><thead><tr>
      <DataTableHeadCell column={header.column} header={header} hasSelect={false} />
    </tr></thead></table>
  );
}

it("opens a cold sortable table heading on its first label click", async () => {
  await act(async () => root.render(<HeaderHarness />));
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { trigger.focus(); trigger.querySelector("span")!.click(); });
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  const currentTrigger = host.querySelector<HTMLButtonElement>("button")!;
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(currentTrigger);
  });
});

it("preserves a custom header renderer even when it supplies a column-menu label", async () => {
  const custom = Object.assign(() => <span>Custom heading</span>, { label: "Menu label" });
  await act(async () => root.render(<HeaderHarness columns={[{ accessorKey: "name", header: custom }]} />));
  expect(host.querySelector("th")?.textContent).toBe("Custom heading");
  expect(host.querySelector('button[aria-haspopup="menu"]')).toBeNull();
});

it("opens the lazy row menu and returns focus on Escape", async () => {
  await act(async () => root.render(<DataTableRowActions onEdit={vi.fn()} />));
  await openAndEscape();
});

it("opens the lazy heading menu and returns focus", async () => {
  const column = {
    id: "name", columnDef: { header: "Product", meta: { mobile: "primary" } },
    getCanSort: () => true, getIsSorted: () => false, toggleSorting: vi.fn(),
  } as unknown as Column<{ id: string }, unknown>;
  await act(async () => root.render(<DataTableColumnHeader column={column} title="Product" />));
  await openAndEscape();
});

type MenuKind = "heading" | "date-heading" | "table-row" | "card-row";

function RefreshingColumns({ kind, label, onEdit }: { kind: MenuKind; label: string; onEdit: () => void }) {
  const columns: ColumnDef<(typeof headerRows)[number], unknown>[] = kind === "heading"
    ? [{ accessorKey: "name", header: sortHeader(label), meta: { primary: true } }]
    : kind === "date-heading"
      ? [createDateColumn("name", label)]
      : [createActionsColumn({ showTrashed: false, onEdit, getMenuLabel: () => label })];
  const table = useTable({ features: serverTableFeatures, data: headerRows, columns });
  const header = table.getFlatHeaders()[0]!;
  const row = table.getRowModel().rows[0]!;
  const cell = row.getAllCells()[0]!;
  if (kind === "card-row") return <div>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>;
  return (
    <table>
      {kind.endsWith("heading") ? (
        <thead><tr><DataTableHeadCell column={header.column} header={header} hasSelect={false} /></tr></thead>
      ) : (
        <tbody><DataTableBodyRow cells={row.getAllCells()} density="default" isSelected={false} includeDragColumn={false} hasSelect={false} /></tbody>
      )}
    </table>
  );
}

it.each<MenuKind>(["heading", "date-heading", "table-row", "card-row"])("keeps the %s menu and focus when column definitions refresh", async (kind) => {
  const oldEdit = vi.fn();
  const newEdit = vi.fn();
  await act(async () => root.render(<RefreshingColumns kind={kind} label="Before" onEdit={oldEdit} />));
  const opener = host.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { opener.focus(); opener.click(); });
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  const trigger = host.querySelector<HTMLButtonElement>("button")!;

  await act(async () => root.render(<RefreshingColumns kind={kind} label="After" onEdit={newEdit} />));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(host.querySelector("button")).toBe(trigger);
  expect(kind.endsWith("heading") ? trigger.textContent : trigger.getAttribute("aria-label")).toBe("After");

  if (kind.endsWith("heading")) {
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  } else {
    await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(newEdit).toHaveBeenCalledOnce();
    expect(oldEdit).not.toHaveBeenCalled();
  }
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
