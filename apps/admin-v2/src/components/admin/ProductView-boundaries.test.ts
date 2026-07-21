import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PRODUCT_VIEW_SOURCE = fileURLToPath(
  new URL("./ProductView.tsx", import.meta.url),
);

describe("ProductView catalog truth boundaries", () => {
  it("does not render untracked simple SKUs as zero available stock", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain('import type { ProductDetail, ProductMediaDetail }');
    expect(source).toContain("v.trackInventory !== false");
    expect(source).toContain("Product SKU");
    expect(source).not.toContain("Simple product SKU");
    expect(source).toContain("No stock limit");
    expect(source).toContain("v.selectedOptions.map((option) => `${option.name}: ${option.value}`)");
    expect(source).not.toContain("variantOption1Label");
    expect(source).not.toContain("variantOption2Label");
    expect(source).toContain("available === null");
    expect(source).toContain("const available = inventoryTracked ? v.stock - v.reservedStock : null");
    expect(source).toContain('`${available} deficit`');
  });

  it("shows currency-aware discounts and discovery readiness", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain("const { formatPrice } = useCurrency()");
    expect(source).toContain("product.discountType === \"flat\"");
    expect(source).toContain("variantDiscount");
    expect(source).toContain('product.noIndex ? "Noindex" : "Indexable"');
    expect(source).toContain('product.excludeFromSitemap ? "Not in sitemap" : "In sitemap"');
    expect(source).toContain('product.excludeFromProductFeed ? "Not in feed" : "In feed"');
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

  it("treats the browser-local updated date as an intentional hydration boundary", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain("<span suppressHydrationWarning>");
    expect(source).toContain("{formatDateShort(product.updatedAt)}");
  });

  it("renders video in the media stage without sending video URLs through image optimization", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain('item.kind === "image"');
    expect(source).toContain("<VideoPlayer");
    expect(source).toContain("poster={item.posterUrl ? getOptimizedImageUrl(item.posterUrl) : undefined}");
    expect(source).toContain('src={item.url}');
    expect(source).toContain('preload="metadata"');
    expect(source).not.toContain("getOptimizedImageUrl(item.url)}\n        aria-label");
  });
});
