// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";
import type { VariantPriceRange } from "./variants/option-matrix-editor-model";

const currency = vi.hoisted(() => ({ sale: null as number | null }));
vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (price: number) => `৳${price}`, salePrice: () => currency.sale }),
}));

import { PricingCard } from "./PricingCard";
import { SkuCostProvider, type SkuCostStore } from "./sku-costs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A page cost store holding one SKU's cost. */
function costStore(cost: number | null) {
  const store = {
    simpleKey: "var_default",
    costOf: () => cost,
    setCosts: vi.fn(),
    isDirty: () => false,
    problemOf: () => null,
    rows: { current: [] },
    changes: () => [],
    settle: vi.fn(),
    save: vi.fn(),
    reset: vi.fn(),
    sync: vi.fn(),
  } satisfies SkuCostStore;
  return store;
}

function Harness({ variantPrices, price = 2600, discount = 0 }: {
  variantPrices: VariantPriceRange | null;
  price?: number | null;
  discount?: number;
}) {
  const form = useForm<ProductFormValues>({
    defaultValues: { price, discountType: "percentage", discountPercentage: discount, discountAmount: 0 } as ProductFormValues,
  });
  return <Form {...form}><PricingCard form={form} variantPrices={variantPrices} /></Form>;
}

describe("PricingCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  async function render(node: ReactNode) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(node));
  }

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    currency.sale = null;
  });

  const label = (key: "costPerItem" | "profit" | "margin") => translate(productMessages, key);
  const valueOf = (key: "profit" | "margin") =>
    Array.from(host.querySelectorAll("dt")).find((term) => term.textContent === label(key))?.nextElementSibling?.textContent;
  const costInput = () => Array.from(host.querySelectorAll("label"))
    .find((element) => element.textContent === label("costPerItem"))
    ?.getAttribute("for");

  it("edits one price for a product without options", async () => {
    await render(<Harness variantPrices={null} />);
    expect(host.querySelector<HTMLInputElement>('input[name="price"]')).not.toBeNull();
    // Without the page's cost store (other editors) there is no cost field.
    expect(host.textContent).not.toContain(label("costPerItem"));
  });

  it("shows the variants' range instead of a price nobody pays once options exist", async () => {
    await render(<SkuCostProvider store={costStore(100)}><Harness variantPrices={{ min: 2400, max: 2500 }} /></SkuCostProvider>);
    expect(host.querySelector('input[name="price"]')).toBeNull();
    expect(host.textContent).toContain("৳2400–৳2500");
    expect(host.textContent).not.toContain("2600");
    expect(host.textContent).toContain("Each variant has its own price.");
    // Each variant has its own cost too.
    expect(host.textContent).not.toContain(label("costPerItem"));
  });

  it("shows the profit and margin of what the customer pays after the discount", async () => {
    currency.sale = 800;
    await render(<SkuCostProvider store={costStore(600)}><Harness variantPrices={null} price={1000} discount={20} /></SkuCostProvider>);
    const input = document.getElementById(costInput()!) as HTMLInputElement;
    expect(input.value).toBe("600");
    expect(valueOf("profit")).toBe("৳200");
    expect(valueOf("margin")).toBe("25.0%");
  });

  it("shows dashes without a cost, and no margin at a price of zero", async () => {
    await render(<SkuCostProvider store={costStore(null)}><Harness variantPrices={null} price={500} /></SkuCostProvider>);
    expect(valueOf("profit")).toBe("—");
    expect(valueOf("margin")).toBe("—");
    act(() => root.unmount());
    host.remove();

    await render(<SkuCostProvider store={costStore(40)}><Harness variantPrices={null} price={0} /></SkuCostProvider>);
    expect(valueOf("profit")).toBe("৳-40");
    expect(valueOf("margin")).toBe("—");
  });

  it("types the cost into the page's store, paisa included", async () => {
    const store = costStore(null);
    await render(<SkuCostProvider store={store}><Harness variantPrices={null} /></SkuCostProvider>);
    const input = document.getElementById(costInput()!) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "12.50");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(store.setCosts).toHaveBeenLastCalledWith(["var_default"], 12.5);
  });
});
