// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import type { ProductFormValues } from "./types";
import type { VariantPriceRange } from "./variants/option-matrix-editor-model";

vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (price: number) => `৳${price}`, salePrice: () => null }),
}));

import { PricingCard } from "./PricingCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ variantPrices }: { variantPrices: VariantPriceRange | null }) {
  const form = useForm<ProductFormValues>({
    defaultValues: { price: 2600, discountType: "percentage", discountPercentage: 0, discountAmount: 0 } as ProductFormValues,
  });
  return <Form {...form}><PricingCard form={form} variantPrices={variantPrices} /></Form>;
}

describe("PricingCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  async function render(variantPrices: VariantPriceRange | null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness variantPrices={variantPrices} />));
  }

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("edits one price for a product without options", async () => {
    await render(null);
    expect(host.querySelector<HTMLInputElement>('input[name="price"]')).not.toBeNull();
  });

  it("shows the variants' range instead of a price nobody pays once options exist", async () => {
    await render({ min: 2400, max: 2500 });
    expect(host.querySelector('input[name="price"]')).toBeNull();
    expect(host.textContent).toContain("৳2400–৳2500");
    expect(host.textContent).not.toContain("2600");
    expect(host.textContent).toContain("Each variant has its own price.");
  });
});
