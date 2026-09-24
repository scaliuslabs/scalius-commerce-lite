// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const download = vi.hoisted(() => vi.fn(async (_params: URLSearchParams) => ({ rowCount: 2, limited: false })));
vi.mock("./order-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./order-export")>()),
  downloadOrderExport: download,
}));

import { ExportOrdersDialog } from "./ExportOrdersDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("export orders", () => {
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("offers the selected orders as a scope, chosen by default, and exports exactly those", async () => {
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(
      <ExportOrdersDialog
        open
        onOpenChange={vi.fn()}
        filters={{ view: "returned", sort: "createdAt", order: "desc" }}
        pageIds={["o-1", "o-2", "o-3"]}
        selectedIds={["o-2", "o-3"]}
        allSelected={false}
        total={40}
      />,
    ));

    const selected = document.body.querySelector<HTMLButtonElement>("#export-scope-selected");
    expect(document.body.querySelector('label[for="export-scope-selected"]')?.textContent).toBe("Selected orders (2)");
    expect(selected?.getAttribute("aria-checked")).toBe("true");

    const exportButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "Export orders")!;
    await act(async () => exportButton.click());
    expect(download).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(download.mock.calls[0]![0])).toEqual({ format: "summary", ids: "o-2,o-3", maxRows: "2" });
  });
});
