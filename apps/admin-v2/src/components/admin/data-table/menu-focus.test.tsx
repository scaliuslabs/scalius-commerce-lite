// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DataTableColumnHeader } from "./DataTableColumnHeader";
import { DataTableRowActions } from "./DataTableRowActions";
import type { Column } from "./table-config";

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

it("opens the lazy row menu and returns focus on Escape", async () => {
  await act(async () => root.render(<DataTableRowActions onEdit={vi.fn()} />));
  await openAndEscape();
});

it("opens the lazy heading menu selected by the desktop harness and returns focus", async () => {
  const column = {
    id: "name", columnDef: { header: "Product", meta: { mobile: "primary" } },
    getCanSort: () => true, getIsSorted: () => false, toggleSorting: vi.fn(),
  } as unknown as Column<{ id: string }, unknown>;
  await act(async () => root.render(<DataTableColumnHeader column={column} title="Product" />));
  await openAndEscape();
});
