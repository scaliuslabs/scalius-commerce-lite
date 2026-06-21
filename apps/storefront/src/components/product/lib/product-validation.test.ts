import { describe, expect, it } from "vitest";
import { validateAddToCart } from "./product-validation";

const baseInput = {
  productId: "prod_1",
  slug: "cotton-panjabi",
  name: "Cotton Panjabi",
  price: 150,
  quantity: 1,
};

describe("validateAddToCart", () => {
  it("does not reject untracked simple SKUs just because their stock column is zero", () => {
    const result = validateAddToCart({
      ...baseInput,
      variantId: "var_default_prod_1",
      stock: 0,
      trackInventory: false,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("checks available stock after reservations for tracked SKUs", () => {
    const result = validateAddToCart({
      ...baseInput,
      quantity: 2,
      variantId: "var_red_m",
      stock: 3,
      reservedStock: 2,
      trackInventory: true,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Only 1 item available"]);
  });
});
