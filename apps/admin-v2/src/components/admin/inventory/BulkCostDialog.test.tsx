// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { InventoryVariant } from "~/lib/api-query-options/inventory";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";

const mocks = vi.hoisted(() => ({ putCosts: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({ putApiV1AdminInventoryCosts: mocks.putCosts }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (amount: number) => `৳${amount}`, salePrice: () => null }),
}));

import { BulkCostDialog, bulkCostItems } from "./BulkCostDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const variant = (id: string, optionLabel: string, cost: number | null) => ({
  id, productId: "prod_1", productName: "Panjabi", sku: `PANJABI-${optionLabel}`, optionLabel, stock: 4, reservedStock: 0,
  available: 4, lowStockThreshold: null, version: 1, locationOnHand: null, incoming: 0, cost,
}) as unknown as InventoryVariant;

const t = (key: keyof typeof inventoryMessages.en, vars?: Record<string, string | number>) => translate(inventoryMessages, key, vars);

describe("bulkCostItems", () => {
  it("sends only changed costs, each with the cost the merchant opened the dialog with", () => {
    const seen = new Map<string, number | null>([["a", 100], ["b", null], ["c", 20]]);
    const typed = new Map<string, number | null>([["a", 100], ["b", 55.5], ["c", null]]);
    expect(bulkCostItems(["a", "b", "c", "d"], seen, typed)).toEqual([
      { variantId: "b", cost: 55.5, expectedCost: null },
      { variantId: "c", cost: null, expectedCost: 20 },
    ]);
  });
});

describe("BulkCostDialog", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function type(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const costInput = (option: string) =>
    dialog().querySelector<HTMLInputElement>(`input[aria-label="${t("costFor", { name: `Panjabi · ${option}` })}"]`)!;
  const button = (name: string) => Array.from(dialog().querySelectorAll("button")).find((element) => element.textContent === name)!;
  const save = () => Array.from(document.querySelectorAll("button")).find((element) => element.textContent === translate(resourceMessages, "save"))!;

  async function render(props: Partial<Parameters<typeof BulkCostDialog>[0]> = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onReload: vi.fn(async () => [] as InventoryVariant[]) };
    await act(async () => root.render(
      <BulkCostDialog variants={[variant("var_m", "M", 100), variant("var_l", "L", null)]} open {...handlers} {...props} />,
    ));
    return handlers;
  }

  it("saves the typed and set-all costs with the costs they replace", async () => {
    mocks.putCosts.mockResolvedValue({ items: [] });
    const handlers = await render();
    expect(costInput("M").value).toBe("100");
    expect(costInput("L").value).toBe("");
    expect(save().disabled).toBe(true);

    await act(async () => type(dialog().querySelector<HTMLInputElement>("#inventory-bulk-cost-all")!, "80.25"));
    await act(async () => button(t("applyToAll")).click());
    await act(async () => type(costInput("M"), "90"));
    await act(async () => save().click());

    expect(mocks.putCosts).toHaveBeenCalledWith({
      body: {
        items: [
          { variantId: "var_m", cost: 90, expectedCost: 100 },
          { variantId: "var_l", cost: 80.25, expectedCost: null },
        ],
      },
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t("costsSaved"));
    expect(handlers.onSaved).toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it("blocks a cost below zero", async () => {
    await render();
    await act(async () => type(costInput("M"), "-5"));
    expect(dialog().textContent).toContain(t("costInvalid"));
    expect(save().disabled).toBe(true);
  });

  it("says when a cost changed meanwhile and reloads it, keeping the other typed costs", async () => {
    mocks.putCosts.mockRejectedValueOnce(new AdminApiResponseError("A SKU's cost changed", 409, "conflict"));
    const onReload = vi.fn(async () => [variant("var_m", "M", 104.4), variant("var_l", "L", null)]);
    await render({ onReload });
    await act(async () => type(costInput("M"), "110"));
    await act(async () => type(costInput("L"), "60"));
    await act(async () => save().click());
    expect(dialog().textContent).toContain(t("costChanged"));

    await act(async () => button(t("reloadCosts")).click());
    expect(onReload).toHaveBeenCalled();
    expect(dialog().textContent).not.toContain(t("costChanged"));
    expect(costInput("M").value).toBe("104.4");
    expect(costInput("L").value).toBe("60");

    mocks.putCosts.mockResolvedValueOnce({ items: [] });
    await act(async () => save().click());
    expect(mocks.putCosts).toHaveBeenLastCalledWith({ body: { items: [{ variantId: "var_l", cost: 60, expectedCost: null }] } });
  });
});
