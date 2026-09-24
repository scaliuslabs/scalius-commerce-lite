import { describe, expect, it } from "vitest";
import type { Product } from "./types";
import { discountedUnitPrice, orderItemVariantLabel } from "./order-item-presentation";

type ProductVariant = Product["variants"][number];

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: "variant_1",
    optionCombinationKey: "color:navy",
    selectedOptions: [{ name: "Color", value: "Navy" }],
    weight: null,
    sku: "VAULT-NAVY",
    price: 4490,
    stock: 6,
    ...overrides,
  };
}

describe("manual order item variant labels", () => {
  it("shows the merchant option choice from a lazy-loaded SKU projection", () => {
    expect(orderItemVariantLabel(variant())).toBe("Color: Navy");
  });

  it("says nothing extra for a simple product's default SKU and falls back to the SKU otherwise", () => {
    expect(orderItemVariantLabel(variant({ selectedOptions: [], isDefault: true }))).toBe("");
    expect(orderItemVariantLabel(variant({ selectedOptions: [], isDefault: false }))).toBe("VAULT-NAVY");
    expect(orderItemVariantLabel(undefined)).toBe("—");
  });

  it("applies a variant discount before the product discount", () => {
    const product = {
      id: "p",
      name: "Vault",
      price: 1000,
      discountPercentage: 10,
      variants: [],
    };
    expect(discountedUnitPrice(product, null)).toBe(900);
    expect(discountedUnitPrice(product, variant({ price: 500 }))).toBe(450);
    expect(discountedUnitPrice(
      product,
      variant({ price: 500, discountType: "flat", discountAmount: 600 }),
    )).toBe(0);
    expect(discountedUnitPrice(
      { ...product, discountPercentage: null, discountType: "flat", discountAmount: 50 },
      variant({ price: 500, discountType: "percentage", discountPercentage: 20 }),
    )).toBe(400);
  });
});
