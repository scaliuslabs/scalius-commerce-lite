// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";
import type { VariantPriceRange } from "./variants/option-matrix-editor-model";
import { rebaseForm } from "../shared/use-form-save-bar";

const currency = vi.hoisted(() => ({ sale: null as number | null | undefined }));
vi.mock("@/hooks/use-currency", async () => {
  const { discountedPriceMinor, fromMinor, percentToBps, toMinor } = await import("@scalius/shared/money");
  return {
    useCurrency: () => ({
      symbol: "৳", code: "BDT", fmt: (price: number) => `৳${price}`,
      salePrice: (price: number, discount: Pick<ProductFormValues, "discountType" | "discountPercentage" | "discountAmount">) => {
        if (currency.sale !== undefined) return currency.sale;
        const base = toMinor(price, 2);
        const sale = discountedPriceMinor(base, discount.discountType, percentToBps(discount.discountPercentage), toMinor(discount.discountAmount ?? 0, 2), 100);
        return sale < base ? fromMinor(sale, 2) : null;
      },
    }),
  };
});

import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { PermissionProvider } from "~/contexts/PermissionContext";
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

function Harness({ variantPrices, price = 2600, discount = 0, discountType = "percentage", discountAmount = 0, onForm, readOnly = false }: {
  variantPrices: VariantPriceRange | null;
  price?: number | null;
  discount?: number | null;
  discountType?: ProductFormValues["discountType"];
  discountAmount?: number | null;
  onForm?: (form: UseFormReturn<ProductFormValues>) => void;
  readOnly?: boolean;
}) {
  const form = useForm<ProductFormValues>({
    defaultValues: { price, discountType, discountPercentage: discount, discountAmount, compareAtProblem: null },
  });
  onForm?.(form);
  // Reading it while rendering subscribes the harness to dirty state.
  void form.formState.isDirty;
  return <Form {...form}><PricingCard form={form} variantPrices={variantPrices} readOnly={readOnly} /></Form>;
}

describe("PricingCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  async function render(node: ReactNode, permissions: string[] = [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_VIEW_COSTS]) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<PermissionProvider permissions={permissions}>{node}</PermissionProvider>));
  }

  it("shows no cost per item without View product costs", async () => {
    await render(<SkuCostProvider store={costStore(600)}><Harness variantPrices={null} price={1000} /></SkuCostProvider>, [PERMISSIONS.PRODUCTS_VIEW]);
    expect(host.textContent).not.toContain(translate(productMessages, "costPerItem"));
    expect(host.textContent).not.toContain("৳600");
  });

  describe("read only", () => {
    it("shows a zero price as an amount, with no inputs and no form writes", async () => {
      let form!: UseFormReturn<ProductFormValues>;
      await render(<Harness readOnly variantPrices={null} price={0} onForm={(f) => { form = f; }} />);
      expect(host.textContent).toContain("৳0");
      expect(host.querySelectorAll("input")).toHaveLength(0);
      expect(form.getValues("compareAtProblem")).toBeNull();
      expect(form.formState.isDirty).toBe(false);
    });

    it("shows an empty price as empty, not zero", async () => {
      await render(<Harness readOnly variantPrices={null} price={null} />);
      expect(host.textContent).toContain("—");
      expect(host.textContent).not.toContain("৳");
    });

    it("shows a discounted price with its compare-at price", async () => {
      currency.sale = 2000;
      await render(<Harness readOnly variantPrices={null} price={2600} discount={23} />);
      expect(host.textContent).toContain("৳2000");
      expect(host.textContent).toContain("৳2600");
      expect(host.textContent).toContain(translate(productMessages, "compareAtLabel"));
      expect(host.querySelectorAll("input")).toHaveLength(0);
    });

    // With options each variant carries its own compare-at price: no product discount to show (buyer QA B1).
    it("shows only the option price range customers pay", async () => {
      await render(<Harness readOnly variantPrices={{ min: 100, max: 200 }} price={100} />);
      expect(host.textContent).toContain("৳100–৳200");
      expect(host.textContent).not.toContain(translate(productMessages, "discountType"));
      expect(host.querySelectorAll("input, [role=combobox]")).toHaveLength(0);
    });

    it("shows the cost per item as text only with View product costs", async () => {
      const store = costStore(600);
      await render(<SkuCostProvider store={store}><Harness readOnly variantPrices={null} price={1000} /></SkuCostProvider>);
      expect(host.textContent).toContain(translate(productMessages, "costPerItem"));
      expect(host.textContent).toContain("৳600");
      expect(host.querySelectorAll("input")).toHaveLength(0);
      expect(store.setCosts).not.toHaveBeenCalled();
      act(() => root.unmount());
      host.remove();
      await render(<SkuCostProvider store={costStore(600)}><Harness readOnly variantPrices={null} price={1000} /></SkuCostProvider>, [PERMISSIONS.PRODUCTS_VIEW]);
      expect(host.textContent).not.toContain("৳600");
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    currency.sale = null;
  });

  const label = (key: "costPerItem" | "profit" | "margin") => translate(productMessages, key);
  const valueOf = (key: "profit" | "margin") =>
    Array.from(host.querySelectorAll('[data-slot="field-label"]')).find((term) => term.textContent === label(key))?.nextElementSibling?.textContent;
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

  const field = (labelKey: "priceLabel" | "compareAtLabel") => {
    const text = translate(productMessages, labelKey, { symbol: "৳" });
    const id = Array.from(host.querySelectorAll("label")).find((element) => element.textContent === text)?.getAttribute("for");
    return document.getElementById(id!) as HTMLInputElement;
  };
  const type = (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("stores a compare-at price as the base price with a flat discount", async () => {
    let form!: UseFormReturn<ProductFormValues>;
    await render(<Harness variantPrices={null} price={null} onForm={(next) => { form = next; }} />);
    await type(field("priceLabel"), "800");
    expect(form.getValues("price")).toBe(800);
    await type(field("compareAtLabel"), "1");
    // Half-typed: the price stays, nothing is discounted, and the save is held back.
    expect(form.getValues("price")).toBe(800);
    expect(form.getValues("compareAtProblem")).toBe("notHigher");
    await type(field("compareAtLabel"), "1000");
    expect(form.getValues()).toMatchObject({ price: 1000, discountType: "flat", discountAmount: 200, compareAtProblem: null });
    expect(field("priceLabel").value).toBe("800");
    expect(form.formState.isDirty).toBe(true);
    // Clearing it takes the discount off and keeps the selling price (the mocked currency now reports the sale).
    currency.sale = 800;
    await type(field("compareAtLabel"), "");
    expect(form.getValues()).toMatchObject({ price: 800, discountAmount: 0, compareAtProblem: null });
  });

  it("shows a discounted product as price and compare-at price, and keeps the saving when the price changes", async () => {
    currency.sale = 800;
    let form!: UseFormReturn<ProductFormValues>;
    await render(<Harness variantPrices={null} price={1000} discount={20} onForm={(next) => { form = next; }} />);
    expect(field("priceLabel").value).toBe("800");
    expect(field("compareAtLabel").value).toBe("1000");
    expect(form.formState.isDirty).toBe(false);
    await type(field("priceLabel"), "700");
    expect(form.getValues()).toMatchObject({ price: 1000, discountType: "flat", discountAmount: 300 });
  });

  it.each([[10, 90], [12.5, 88]])("restores the saved %s%% tuple when the rounded visible pair is restored", async (discount, selling) => {
    currency.sale = undefined;
    let form!: UseFormReturn<ProductFormValues>;
    await render(<Harness variantPrices={null} price={100} discount={discount} discountAmount={null} onForm={(next) => { form = next; }} />);
    const saved = form.getValues();
    expect(field("priceLabel").value).toBe(String(selling));
    expect(form.formState.isDirty).toBe(false);
    await type(field("priceLabel"), "85");
    expect(form.getValues()).toMatchObject({ discountType: "flat", discountPercentage: 0, discountAmount: 15 });
    expect(form.formState.isDirty).toBe(true);
    await type(field("priceLabel"), String(selling));
    expect(form.getValues()).toEqual(saved);
    expect(form.formState.isDirty).toBe(false);
    await type(field("compareAtLabel"), "110");
    expect(form.formState.isDirty).toBe(true);
    await type(field("compareAtLabel"), "100");
    expect(form.getValues()).toEqual(saved);
    expect(form.formState.isDirty).toBe(false);
  });

  it.each([null, 0])("preserves an empty discount and a %s price on edit/revert", async (price) => {
    currency.sale = undefined;
    let form!: UseFormReturn<ProductFormValues>;
    await render(<Harness variantPrices={null} price={price} discount={null} discountAmount={null} onForm={(next) => { form = next; }} />);
    const saved = form.getValues();
    expect(form.formState.isDirty).toBe(false);
    await type(field("priceLabel"), "5");
    expect(form.formState.isDirty).toBe(true);
    await type(field("compareAtLabel"), "10");
    expect(form.getValues("discountType")).toBe("flat");
    await type(field("compareAtLabel"), "");
    await type(field("priceLabel"), price === null ? "" : "0");
    expect(form.getValues()).toEqual(saved);
    expect(form.formState.isDirty).toBe(false);
  });

  it("uses the acknowledged or reloaded baseline and discards to it", async () => {
    currency.sale = undefined;
    let form!: UseFormReturn<ProductFormValues>;
    await render(<Harness variantPrices={null} price={100} discount={10} onForm={(next) => { form = next; }} />);
    await type(field("priceLabel"), "85");
    const sent = form.getValues();
    act(() => rebaseForm(form, sent, sent));
    expect(form.formState.isDirty).toBe(false);
    await type(field("priceLabel"), "80");
    expect(form.formState.isDirty).toBe(true);
    await type(field("priceLabel"), "85");
    expect(form.getValues()).toEqual(sent);
    expect(form.formState.isDirty).toBe(false);
    act(() => form.reset({ ...sent, price: 200, discountType: "percentage", discountPercentage: 15, discountAmount: null }));
    expect(field("priceLabel").value).toBe("170");
    await type(field("priceLabel"), "160");
    expect(form.formState.isDirty).toBe(true);
    await type(field("priceLabel"), "170");
    expect(form.getValues()).toMatchObject({ price: 200, discountType: "percentage", discountPercentage: 15, discountAmount: null });
    expect(form.formState.isDirty).toBe(false);
    await type(field("priceLabel"), "160");
    act(() => form.reset());
    expect(field("priceLabel").value).toBe("170");
    expect(form.formState.isDirty).toBe(false);
  });

  it("shows the product discount only for products with options that already have one", async () => {
    await render(<Harness variantPrices={{ min: 100, max: 200 }} />);
    expect(host.querySelector('input[name="discountPercentage"]')).toBeNull();
    expect(host.textContent).not.toContain(translate(productMessages, "compareAtLabel", { symbol: "৳" }));
  });
});
