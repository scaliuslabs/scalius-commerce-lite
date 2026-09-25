// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { translate } from "~/i18n";
import { giftCardProductMessages } from "~/i18n/gift-card-product";
import { productMessages } from "~/i18n/products";
import { FulfilmentCard } from "./FulfilmentCard";
import { PricingCard } from "./PricingCard";
import { StatusCard } from "./StatusCard";
import { constrainSkuForKind, ProductKindRulesContext, productKindRules } from "./product-kind-rules";
import type { ProductFormValues } from "./types";

vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (value: number) => `৳${value}`, salePrice: () => null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("productKindRules", () => {
  it("shows everything for a physical product and weight only where something is packed", () => {
    expect(productKindRules({})).toEqual({
      giftCard: false,
      showShipping: true,
      showWeight: true,
      showDiscount: true,
      showInventory: true,
      forcedFulfillmentKind: null,
    });
    expect(productKindRules({ fulfillmentKind: "service" }).showWeight).toBe(false);
    expect(productKindRules({ fulfillmentKind: "digital" }).showDiscount).toBe(true);
  });

  it("hides shipping, weight, discounts and inventory for a gift card and forces it digital", () => {
    expect(productKindRules({ isGiftCard: true, fulfillmentKind: "physical" })).toEqual({
      giftCard: true,
      showShipping: false,
      showWeight: false,
      showDiscount: false,
      showInventory: false,
      forcedFulfillmentKind: "digital",
    });
  });
});

describe("constrainSkuForKind", () => {
  const sku = {
    trackInventory: true,
    stock: 7,
    discountType: "flat" as const,
    discountPercentage: null,
    discountAmount: 50,
    fulfillmentKind: "physical" as const,
  };

  it("leaves a SKU alone when the kind allows it (same object)", () => {
    expect(constrainSkuForKind(sku, productKindRules({}))).toBe(sku);
  });

  it("makes a gift card's SKU untracked, undiscounted and digital", () => {
    const giftCard = productKindRules({ isGiftCard: true });
    expect(constrainSkuForKind(sku, giftCard)).toEqual({
      trackInventory: false,
      stock: 0,
      discountType: "percentage",
      discountPercentage: null,
      discountAmount: null,
      fulfillmentKind: "digital",
    });
    // A saved SKU keeps its recorded quantity, so the save writes no stock.
    expect(constrainSkuForKind(sku, giftCard, true).stock).toBe(7);
    const already = { trackInventory: false, stock: 0, fulfillmentKind: "digital" as const };
    expect(constrainSkuForKind(already, giftCard)).toBe(already);
  });
});

function Cards({ isGiftCard }: { isGiftCard: boolean }) {
  const form = useForm<ProductFormValues>({
    defaultValues: {
      isGiftCard,
      isActive: true,
      freeDelivery: false,
      productCondition: "new",
      price: 500,
      fulfillmentKind: isGiftCard ? "digital" : "physical",
      discountType: "percentage",
      discountPercentage: 0,
      discountAmount: 0,
    } as ProductFormValues,
  });
  return (
    <ProductKindRulesContext.Provider value={productKindRules({ isGiftCard, fulfillmentKind: form.getValues("fulfillmentKind") })}>
      <Form {...form}>
        <PricingCard form={form} variantPrices={null} />
        <FulfilmentCard form={form} hasOptions={false} />
        <StatusCard form={form} />
      </Form>
    </ProductKindRulesContext.Provider>
  );
}

describe("product cards follow the kind rules", () => {
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

  const p = (key: keyof (typeof productMessages)["en"]) => translate(productMessages, key);

  it("shows discount, the fulfilment choice and free delivery for a regular product", async () => {
    await act(async () => root.render(<Cards isGiftCard={false} />));
    expect(host.textContent).toContain(p("addDiscount"));
    expect(host.textContent).toContain(p("freeDelivery"));
    expect(host.querySelector("#product-fulfilment")).not.toBeNull();
  });

  it("hides discount and free delivery and fixes fulfilment for a gift card", async () => {
    await act(async () => root.render(<Cards isGiftCard />));
    expect(host.textContent).not.toContain(p("addDiscount"));
    expect(host.textContent).not.toContain(p("freeDelivery"));
    expect(host.querySelector("#product-fulfilment")).toBeNull();
    expect(host.textContent).toContain(translate(giftCardProductMessages, "fulfilmentForced"));
  });
});
