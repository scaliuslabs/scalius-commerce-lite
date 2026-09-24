// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemSelection } from "./ItemSelection";
import type { Product } from "./types";
import { orderFormMessages } from "~/i18n/order-form";
import { remainingStockMessage } from "./manual-order-stock";

const en = orderFormMessages.en;
const mocks = vi.hoisted(() => ({ add: vi.fn(), select: vi.fn() }));
vi.mock("./OrderFormContext", () => ({
  useOrderForm: () => ({ form: { watch: () => [] }, refs: { addItemButtonRef: { current: null } }, isEdit: false }),
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (n: number) => `৳${n}` }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const black: Product["variants"][number] = {
  id: "sku_black", optionCombinationKey: "color:black", selectedOptions: [{ name: "Color", value: "Black" }],
  weight: null, sku: "BLACK-1", price: 100, stock: 6, reservedStock: 1,
};
const white = { ...black, id: "sku_white", selectedOptions: [{ name: "Color", value: "White" }] };
const product: Product = { id: "product", name: "Test product", price: 100, discountPercentage: null, variants: [] };

function Fixture(props: React.ComponentProps<typeof ItemSelection>) {
  const form = useForm();
  return <FormProvider {...form}><form><ItemSelection {...props} /></form></FormProvider>;
}

describe("manual order variant choice", () => {
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

  async function render(variants: Product["variants"], selectedVariant = "") {
    await act(async () => root.render(<Fixture
      selectedProduct={{ ...product, variants }} selectedVariant={selectedVariant}
      setSelectedVariant={mocks.select} quantity={1} setQuantity={() => {}}
      handleAddItem={mocks.add}
    />));
  }

  const variantChoice = () => host.querySelector<HTMLButtonElement>('[role="combobox"]');
  const addButton = () => Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === en.add)!;

  it("requires a variant choice before adding and shows its remaining stock", async () => {
    await render([black, white]);
    expect(variantChoice()?.disabled).toBe(false);
    expect(addButton().disabled).toBe(true);

    await act(async () => variantChoice()!.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((candidate) => candidate.textContent?.includes("Color: White"));
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(mocks.select).toHaveBeenLastCalledWith(white.id);

    await render([black, white], white.id);
    expect(host.textContent).toContain(remainingStockMessage(5));
    expect(addButton().disabled).toBe(false);
    await act(async () => addButton().click());
    expect(mocks.add).toHaveBeenCalledOnce();
  });

  it("keeps a product without a variant for sale unaddable", async () => {
    await render([]);
    expect(variantChoice()?.disabled).toBe(true);
    expect(variantChoice()?.textContent).toBe(en.noVariantForSale);
    expect(addButton().disabled).toBe(true);
  });
});
