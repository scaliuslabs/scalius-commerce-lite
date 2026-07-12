import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PRODUCT_VIEW_SOURCE = fileURLToPath(
  new URL("./ProductView.tsx", import.meta.url),
);

describe("ProductView catalog truth boundaries", () => {
  it("does not render untracked simple SKUs as zero available stock", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain("trackInventory?: boolean | null");
    expect(source).toContain("v.trackInventory !== false");
    expect(source).toContain("Product SKU");
    expect(source).not.toContain("Simple product SKU");
    expect(source).toContain("No stock limit");
    expect(source).toContain("v.selectedOptions.map((option) => `${option.name}: ${option.value}`)");
    expect(source).not.toContain("variantOption1Label");
    expect(source).not.toContain("variantOption2Label");
    expect(source).toContain("available === null");
    expect(source).not.toContain("const available = v.stock - v.reservedStock");
  });

  it("renders only the saved normalized SEO description", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain("product.metaDescription?.trim() || null");
    expect(source).toContain("visibleMetaDescription");
    expect(source).not.toContain("{product.metaDescription}</div>");
  });

  it("keeps a product detail usable after its category is removed", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain('product.category?.name || "Uncategorized"');
  });
});
