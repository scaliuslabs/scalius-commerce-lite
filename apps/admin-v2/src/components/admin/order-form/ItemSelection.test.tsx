// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemSelection } from "./ItemSelection";
import type { Product } from "./types";

const mocks = vi.hoisted(() => ({ add: vi.fn(), select: vi.fn() }));
vi.mock("./OrderFormContext", () => ({
  useOrderForm: () => ({ form: { watch: () => [] }, refs: { addItemButtonRef: { current: null } }, isEdit: false }),
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ symbol: "৳" }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const variant: Product["variants"][number] = {
  id: "sku_black", optionCombinationKey: "color:black", selectedOptions: [{ name: "Color", value: "Black" }],
  weight: null, sku: "BLACK-1", price: 100, stock: 6, reservedStock: 1,
};
const product: Product = { id: "product", name: "Test product", price: 100, discountPercentage: null, variants: [] };

function Fixture(props: React.ComponentProps<typeof ItemSelection>) {
  const form = useForm();
  return <FormProvider {...form}><form><ItemSelection {...props} /></form></FormProvider>;
}

describe("manual order SKU choice", () => {
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

  async function render(variants: Product["variants"], isLoadingVariants = false, selectedVariant = "") {
    await act(async () => root.render(<Fixture
      selectedProduct={{ ...product, variants }} selectedVariant={selectedVariant}
      setSelectedVariant={mocks.select} quantity={1} setQuantity={() => {}}
      handleAddItem={mocks.add} calculateDiscountedPrice={() => "100.00"}
      isLoadingVariants={isLoadingVariants}
    />));
  }

  const skuChoice = () => host.querySelector<HTMLButtonElement>('[role="combobox"]');
  const addButton = () => Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Add Item")!;

  describe.each([
    { label: "Product SKU", sku: { ...variant, isDefault: true, selectedOptions: [] } },
    { label: "Color: Black", sku: variant },
  ])("$label", ({ label, sku }) => {
    it.each(["", variant.id])("shows the sole loaded SKU with selectedVariant=%j", async (selectedVariant) => {
      await render([], true);
      expect(skuChoice()?.disabled).toBe(true);
      expect(skuChoice()?.textContent).toBe("Loading SKUs...");
      expect(Array.from(host.querySelectorAll("button")).at(-1)?.disabled).toBe(true);

      await render([sku], false, selectedVariant);
      const output = host.querySelector("output");
      expect(output?.textContent).toBe(label);
      expect(host.querySelector(`label[for="${output?.id}"]`)?.textContent).toBe("SKU");
      expect(skuChoice()).toBeNull();
      expect(host.textContent).toContain("5 available for this order.");
      expect(addButton().disabled).toBe(false);
      await act(async () => addButton().click());
      expect(mocks.add).toHaveBeenCalledOnce();
      expect(mocks.select).not.toHaveBeenCalled();
    });
  });

  it("restores the real choice for multiple SKUs and preserves the empty state", async () => {
    await render([variant]);
    const second = { ...variant, id: "sku_white", selectedOptions: [{ name: "Color", value: "White" }] };
    await render([variant, second]);
    expect(host.querySelector("output")).toBeNull();
    expect(skuChoice()?.disabled).toBe(false);
    expect(addButton().disabled).toBe(true);
    await act(async () => skuChoice()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const white = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Color: White"));
    expect(white).toBeDefined();
    await act(async () => white!.click());
    expect(mocks.select).toHaveBeenLastCalledWith(second.id);
    await render([variant, second], false, second.id);
    expect(addButton().disabled).toBe(false);

    await render([]);
    expect(skuChoice()?.disabled).toBe(true);
    expect(skuChoice()?.textContent).toBe("No active SKU");
    expect(addButton().disabled).toBe(true);
  });
});
