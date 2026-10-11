// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";

const mocks = vi.hoisted(() => ({ mobile: false, canEdit: true, canViewCosts: true, list: vi.fn(), navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => mocks.navigate,
}));
vi.mock("~/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (amount: number) => `৳${amount}`, salePrice: () => null }),
}));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({
    inventory: {
      canAdjustStock: mocks.canEdit,
      canAcknowledgeAlerts: mocks.canEdit,
      canViewCosts: mocks.canViewCosts,
      canEditCosts: mocks.canEdit && mocks.canViewCosts,
    },
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

import {
  postApiV1AdminInventoryByVariantIdAdjust,
  postApiV1AdminInventoryStockSet,
  putApiV1AdminInventoryByVariantIdAlertLevel,
} from "@scalius/api-client/sdk";
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
    mocks.canViewCosts = true;
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

  it.each([false, true])("opens Adjust for the chosen SKU from row actions (phone: %s)", async (mobile) => {
    mocks.mobile = mobile;
    await render();
    const name = "Kori Trainer · 43";
    const actions = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "actionsFor", { name })}"]`)!;
    expect(actions).not.toBeNull();
    expect(host.querySelector(`button[aria-label="${t("adjustFor", { name })}"]`)).toBeNull();
    await act(async () => {
      if (mobile) actions.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      else actions.click();
      await import("~/components/admin/data-table/DataTableRowActionsMenu");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const adjust = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent === t("adjust"));
    expect(adjust).toBeDefined();
    await act(async () => {
      adjust!.click();
      await import("./AdjustStockDialog");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(t("adjustTitle"));
    expect(dialog.textContent).toContain("Kori Trainer · 43 · KORI-43");
    expect(dialog.textContent).not.toContain("KORI-42");
    const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === translate(resourceMessages, "cancel"))!;
    await act(async () => cancel.click());
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const opener = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "actionsFor", { name })}"]`);
      expect(opener).not.toBeNull();
      expect(document.activeElement).toBe(opener);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(postApiV1AdminInventoryByVariantIdAdjust).not.toHaveBeenCalled();
    expect(postApiV1AdminInventoryStockSet).not.toHaveBeenCalled();
    expect(putApiV1AdminInventoryByVariantIdAlertLevel).not.toHaveBeenCalled();
  });

  it.each([false, true])("omits Adjust actions without stock permission (phone: %s)", async (mobile) => {
    mocks.mobile = mobile;
    mocks.canEdit = false;
    await render();
    for (const name of ["Kori Trainer · 42", "Kori Trainer · 43"]) {
      expect(host.querySelector(`button[aria-label="${translate(resourceMessages, "actionsFor", { name })}"]`)).toBeNull();
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull();
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

  it("shows no cost column, cost line or cost edit without View product costs", async () => {
    mocks.canViewCosts = false;
    await render();
    expect(Array.from(host.querySelectorAll("th")).map((cell) => cell.textContent)).not.toContain(t("cost"));
    expect(host.textContent).not.toContain("৳120.5");
    expect(host.textContent).not.toContain(t("noCost"));
    const select = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "select", { name: "KORI-42" })}"]`)!;
    await act(async () => select.click());
    expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent === t("editCost"))).toBe(false);
  });

  it("offers no cost edit without permission to edit products", async () => {
    mocks.canEdit = false;
    await render();
    const select = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "select", { name: "KORI-42" })}"]`)!;
    await act(async () => select.click());
    expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent === t("editCost"))).toBe(false);
  });
});
