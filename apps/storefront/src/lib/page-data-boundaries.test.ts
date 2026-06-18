import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STOREFRONT_SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("storefront page data boundaries", () => {
  it("keeps product detail scoped widget reads in the first dependent fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/products/[slug].astro`,
      "utf8",
    );

    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const productPromiseIndex = source.indexOf(
      "const productPromise = getProductBySlug(slug)",
    );
    const widgetsPromiseIndex = source.indexOf(
      "const productWidgetsPromise = productPromise.then",
    );
    const promiseAllIndex = source.indexOf(
      "fetchedProductWidgets] = await Promise.all([",
    );
    const lateWidgetAwaitIndex = source.indexOf(
      "await getActiveWidgetsForScope(\"product\"",
      promiseAllIndex,
    );

    expect(layoutPromiseIndex).toBeGreaterThan(-1);
    expect(productPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(widgetsPromiseIndex).toBeGreaterThan(productPromiseIndex);
    expect(promiseAllIndex).toBeGreaterThan(widgetsPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("productWidgetsPromise");
    expect(lateWidgetAwaitIndex).toBe(-1);
  });

  it("keeps category cold-cache reads in the first fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/categories/[slug].astro`,
      "utf8",
    );

    const dynamicCheckIndex = source.indexOf(
      "const hasDynamicFilters = hasDynamicProductListFilterParams(params)",
    );
    const optionsIndex = source.indexOf(
      "let productListOptions: ProductListOptions = queryState.options",
    );
    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const attributesPromiseIndex = source.indexOf(
      "const attributesPromise = getFilterableAttributes({ categorySlug: slug })",
    );
    const dynamicBranchIndex = source.indexOf("if (hasDynamicFilters)");
    const dynamicProductsIndex = source.indexOf(
      "productsResponse = await getProductsByCategory(slug, productListOptions)",
    );
    const fastProductsPromiseIndex = source.indexOf(
      "const productsPromise = getProductsByCategory(slug, productListOptions)",
    );
    const categoryFetchIndex = source.indexOf("getCategoryBySlug");
    const widgetsPromiseIndex = source.indexOf(
      "const widgetsPromise = productsPromise.then",
    );
    const promiseAllIndex = source.indexOf(
      "] = await Promise.all([",
      widgetsPromiseIndex,
    );

    expect(dynamicCheckIndex).toBeGreaterThan(-1);
    expect(optionsIndex).toBeGreaterThan(-1);
    expect(layoutPromiseIndex).toBeGreaterThan(optionsIndex);
    expect(attributesPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(dynamicBranchIndex).toBeGreaterThan(attributesPromiseIndex);
    expect(dynamicProductsIndex).toBeGreaterThan(dynamicBranchIndex);
    expect(fastProductsPromiseIndex).toBeGreaterThan(dynamicProductsIndex);
    expect(categoryFetchIndex).toBe(-1);
    expect(widgetsPromiseIndex).toBeGreaterThan(fastProductsPromiseIndex);
    expect(promiseAllIndex).toBeGreaterThan(widgetsPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("productsPromise");
    expect(source.slice(promiseAllIndex)).toContain("attributesPromise");
    expect(source.slice(promiseAllIndex)).toContain("widgetsPromise");
  });

  it("keeps search cold-cache reads in the first fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/search/index.astro`,
      "utf8",
    );

    const dynamicCheckIndex = source.indexOf(
      "const hasDynamicFilters = hasDynamicProductListFilterParams(params)",
    );
    const optionsIndex = source.indexOf(
      "let productListOptions: ProductListOptions = queryState.options",
    );
    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const attributesPromiseIndex = source.indexOf(
      "const attributesPromise = getFilterableAttributes({ searchQuery: query })",
    );
    const dynamicBranchIndex = source.indexOf("if (hasDynamicFilters)");
    const dynamicProductsIndex = source.indexOf(
      "productsResponse = await getAllProducts(productListOptions)",
    );
    const fastProductsPromiseIndex = source.indexOf(
      "const productsPromise = getAllProducts(productListOptions)",
    );
    const promiseAllIndex = source.indexOf("] = await Promise.all([");

    expect(dynamicCheckIndex).toBeGreaterThan(-1);
    expect(optionsIndex).toBeGreaterThan(-1);
    expect(layoutPromiseIndex).toBeGreaterThan(optionsIndex);
    expect(attributesPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(dynamicBranchIndex).toBeGreaterThan(attributesPromiseIndex);
    expect(dynamicProductsIndex).toBeGreaterThan(dynamicBranchIndex);
    expect(fastProductsPromiseIndex).toBeGreaterThan(dynamicProductsIndex);
    expect(promiseAllIndex).toBeGreaterThan(attributesPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("productsPromise");
    expect(source.slice(promiseAllIndex)).toContain("attributesPromise");
  });

  it("trusts CMS page render data without refetching page widgets", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/[slug].astro`,
      "utf8",
    );

    expect(source).toContain("const pageWidgets = pageRenderData?.widgets ?? []");
    expect(source).not.toContain("getActiveWidgetsForScope(\"page\"");
  });
});
