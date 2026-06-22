import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCT_PAGE_SOURCE = fileURLToPath(new URL("../pages/products/[slug].astro", import.meta.url));

describe("product detail page SKU boundaries", () => {
  it("uses product.hasVariants for customer option metadata instead of buyer SKU count", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("data-product-has-variants={product.hasVariants.toString()}");
    expect(source).not.toContain("data-product-has-variants={(buyerVariants.length > 0).toString()}");
  });
});
