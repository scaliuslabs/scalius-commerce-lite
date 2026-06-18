import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("category route query boundaries", () => {
  it("keeps category metadata and attribute filter resolution in one wave", () => {
    const source = readFileSync(`${ROUTES_DIR}/categories.ts`, "utf8");

    const categoryAttributesWaveIndex = source.indexOf(
      "const [category, attributeFilters] = await Promise.all([",
    );
    const categoryReadIndex = source.indexOf(
      "getPublicCategoryBySlug(db, slug)",
      categoryAttributesWaveIndex,
    );
    const attributesReadIndex = source.indexOf(
      "resolvePublicAttributeFilters(db, queryParams, Object.keys(params))",
      categoryAttributesWaveIndex,
    );
    const categoryNotFoundIndex = source.indexOf("if (!category)", categoryAttributesWaveIndex);
    const productHelperIndex = source.indexOf("getStorefrontCategoryProducts(", categoryNotFoundIndex);

    expect(categoryAttributesWaveIndex).toBeGreaterThan(-1);
    expect(categoryReadIndex).toBeGreaterThan(categoryAttributesWaveIndex);
    expect(attributesReadIndex).toBeGreaterThan(categoryAttributesWaveIndex);
    expect(categoryNotFoundIndex).toBeGreaterThan(attributesReadIndex);
    expect(productHelperIndex).toBeGreaterThan(categoryNotFoundIndex);
  });

  it("keeps category product SQL out of the route layer", () => {
    const source = readFileSync(`${ROUTES_DIR}/categories.ts`, "utf8");

    expect(source).toContain("getStorefrontCategoryProducts");
    expect(source).not.toContain("let countQuery = db");
    expect(source).not.toContain(".from(products)");
    expect(source).not.toContain(".from(productImages)");
    expect(source).not.toContain("calculateDiscountedPrice");
    expect(source).not.toContain("ftsMatch");
  });

  it("keeps category-products responses carrying full category metadata", () => {
    const source = readFileSync(`${ROUTES_DIR}/categories.ts`, "utf8");
    const routeSchemaIndex = source.indexOf("const getCategoryProductsRoute = createRoute(");
    const categorySchemaIndex = source.indexOf("category: storefrontCategorySchema", routeSchemaIndex);
    const categoryForProductsIndex = source.indexOf("const categoryForProducts = {");
    const productHelperIndex = source.indexOf("getStorefrontCategoryProducts(", categoryForProductsIndex);

    expect(routeSchemaIndex).toBeGreaterThan(-1);
    expect(categorySchemaIndex).toBeGreaterThan(routeSchemaIndex);
    expect(categoryForProductsIndex).toBeGreaterThan(categorySchemaIndex);
    expect(source.slice(categoryForProductsIndex, productHelperIndex)).toContain("createdAt: category.createdAt");
    expect(source.slice(categoryForProductsIndex, productHelperIndex)).toContain("updatedAt: category.updatedAt");
  });
});
