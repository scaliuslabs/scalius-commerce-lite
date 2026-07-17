import { describe, expect, it } from "vitest";
import type { Product } from "./types";
import { orderItemVariantLabel } from "./order-item-presentation";

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

  it("keeps a truthful SKU fallback for default and optionless rows", () => {
    expect(orderItemVariantLabel(variant({ selectedOptions: [], isDefault: true }))).toBe("Product SKU");
    expect(orderItemVariantLabel(variant({ selectedOptions: [], isDefault: false }))).toBe("VAULT-NAVY");
    expect(orderItemVariantLabel(undefined)).toBe("—");
  });
});
