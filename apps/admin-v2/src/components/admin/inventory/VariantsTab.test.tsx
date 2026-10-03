// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";

const mocks = vi.hoisted(() => ({ mobile: false, canEdit: true, list: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => () => undefined,
}));
vi.mock("~/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (amount: number) => `৳${amount}`, salePrice: () => null }),
}));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({
    inventory: { canAdjustStock: mocks.canEdit, canAcknowledgeAlerts: mocks.canEdit },
  }),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventory: mocks.list,
  getApiV1AdminInventoryLocations: async () => ({ locations: [] }),
  putApiV1AdminInventoryCosts: vi.fn(),
  postApiV1AdminInventoryByVariantIdAdjust: vi.fn(),
  postApiV1AdminInventoryStockSet: vi.fn(),
  putApiV1AdminInventoryByVariantIdAlertLevel: vi.fn(),
}));

import { VariantsTab } from "./VariantsTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const variant = (id: string, sku: string, incoming: number, cost: number | null) => ({
  id, productId: "prod_1", productName: "Kori Trainer", sku, optionLabel: sku.slice(-2), stock: 4, reservedStock: 1,
  available: 3, lowStockThreshold: null, version: 1, locationOnHand: null, incoming, cost,
});

describe("VariantsTab incoming stock and unit cost", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.list.mockResolvedValue({
      variants: [variant("var_1", "KORI-42", 5, 120.5), variant("var_2", "KORI-43", 0, null)],
      pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    mocks.mobile = false;
    mocks.canEdit = true;
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <VariantsTab filters={{ q: "", stock: "all", location: "" }} onFiltersChange={() => undefined} onSelectionChange={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("KORI-43"));
  }

  const t = (key: keyof typeof inventoryMessages.en, vars?: Record<string, string | number>) => translate(inventoryMessages, key, vars);

  it("shows incoming units and the unit cost as columns on wide screens", async () => {
    await render();
    const headers = Array.from(host.querySelectorAll("th")).map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining([t("incoming"), t("cost")]));

    const rowOf = (sku: string) => Array.from(host.querySelectorAll("tbody tr")).find((row) => row.textContent?.includes(sku))!;
    const cells = (sku: string) => Array.from(rowOf(sku).querySelectorAll("td")).map((cell) => cell.textContent);
    expect(cells("KORI-42")).toEqual(expect.arrayContaining(["5", "৳120.5"]));
    // Nothing coming reads 0 (muted); no cost reads as a dash, named for screen readers.
    expect(cells("KORI-43")).toEqual(expect.arrayContaining(["0", `—${t("noCost")}`]));
  });

  it("shows them on the phone cards too", async () => {
    mocks.mobile = true;
    await render();
    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).toContain(`${t("incomingCount", { count: 5 })} · ${t("costValue", { amount: "৳120.5" })}`);
    expect(host.textContent).toContain(t("noCost"));
    expect(host.textContent).not.toContain(t("incomingCount", { count: 0 }));
  });

  it("edits the cost of the selected SKUs in one dialog", async () => {
    await render();
    const select = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "select", { name: "KORI-42" })}"]`)!;
    await act(async () => select.click());
    const editCost = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === t("editCost"))!;
    await act(async () => editCost.click());
    // The dialog's code loads on the first Edit cost.
    await act(async () => {
      await import("./BulkCostDialog");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(t("costDialogTitle"));
    expect(dialog.textContent).toContain(t("costDialogDescriptionOne"));
    const input = dialog.querySelector<HTMLInputElement>(`input[aria-label="${t("costFor", { name: "Kori Trainer · 42" })}"]`)!;
    expect(input.value).toBe("120.5");
  });

  it("offers no cost edit without permission to edit products", async () => {
    mocks.canEdit = false;
    await render();
    const select = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "select", { name: "KORI-42" })}"]`)!;
    await act(async () => select.click());
    expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent === t("editCost"))).toBe(false);
  });
});
