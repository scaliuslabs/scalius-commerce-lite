import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public search buyer-catalog boundaries", () => {
  it("uses the shared SKU projection and preserves operational failures", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("buildBuyerCatalogPricingProjection");
    expect(source).toContain("buyerCatalogHasSkuInPriceRange");
    expect(source).toContain(".innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))");
    expect(source).toContain("discountedPrice: buyerPricing.effectivePrice");
    expect(source).toContain("priceVaries: maxBuyerPrice > product.discountedPrice");
    expect(source).not.toContain("gte(products.price");
    expect(source).not.toContain("lte(products.price");
    expect(source).toContain("throw error;");
  });

  it("projects the predictive thumbnail without a second media read", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("imageProjection: buildSearchImageProjection()");
    expect(source).toContain("FROM product_media AS search_product_media");
    expect(source).toContain("search_poster.status IN ('ready', 'trashed')");
    expect(source).toContain("parseSearchImageProjection(imageProjection)");
    expect(source).not.toContain("loadProductMediaProjections");
  });
});
