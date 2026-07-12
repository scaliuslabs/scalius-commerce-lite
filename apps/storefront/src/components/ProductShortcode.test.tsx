// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductShortcode from "./ProductShortcode";
import type { ProductPageData } from "@/lib/api";

vi.mock("@/store/cart", () => ({ addToCart: vi.fn(() => true) }));
vi.mock("@/lib/analytics", () => ({ trackFbAddToCart: vi.fn() }));

const option = { id: "format", name: "Format", position: 0, standardMapping: "none" as const, values: [
  { id: "digital", value: "Digital", position: 0 },
  { id: "print", value: "Print", position: 1 },
] };

function data(): ProductPageData {
  const base = {
    productId: "prod_1", optionCombinationKey: "", imageId: null, weight: null, price: 100,
    reservedStock: 0, isDefault: false, trackInventory: true, discountType: null,
    discountPercentage: null, discountAmount: null, createdAt: "2026-01-01", updatedAt: "2026-01-01", deletedAt: null,
  };
  return {
    product: {
      id: "prod_1", name: "Guide", slug: "guide", description: null, price: 100,
      discountType: null, discountPercentage: null, discountAmount: null, discountedPrice: 100,
      freeDelivery: false, isActive: true, metaTitle: null, metaDescription: null,
      categoryId: "cat_1", createdAt: "2026-01-01", updatedAt: "2026-01-01", deletedAt: null,
      hasVariants: true, options: [option],
    },
    category: undefined,
    images: [],
    variants: [
      { ...base, id: "var_digital", optionCombinationKey: "digital", sku: "DIGITAL", stock: 10, selectedOptions: [{ optionDefinitionId: "format", optionValueId: "digital", name: "Format", value: "Digital", position: 0, valuePosition: 0, standardMapping: "none" }] },
      { ...base, id: "var_print", optionCombinationKey: "print", sku: "PRINT", stock: 0, selectedOptions: [{ optionDefinitionId: "format", optionValueId: "print", name: "Format", value: "Print", position: 0, valuePosition: 1, standardMapping: "none" }] },
    ],
    relatedProducts: [],
  };
}

describe("ProductShortcode normalized options", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  afterEach(() => act(() => root.render(<></>)));

  it("renders arbitrary option names and disables sold-out values", () => {
    act(() => root.render(<ProductShortcode productData={data()} />));
    expect(host.textContent).toContain("Format");
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.find((button) => button.textContent === "Print")?.hasAttribute("disabled")).toBe(true);
  });
});
