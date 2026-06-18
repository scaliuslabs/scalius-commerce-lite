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

    const optionsIndex = source.indexOf("const productListOptions");
    const queryMapIndex = source.indexOf("productListOptions.search = query");
    const filterParamsIndex = source.indexOf('const filterParams = ["q", "page", "sortBy"]');
    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const productsPromiseIndex = source.indexOf(
      "const productsPromise = getProductsByCategory(slug, productListOptions)",
    );
    const attributesPromiseIndex = source.indexOf(
      "const attributesPromise = getFilterableAttributes({ categorySlug: slug })",
    );
    const widgetsPromiseIndex = source.indexOf(
      "const widgetsPromise = categoryPromise.then",
    );
    const promiseAllIndex = source.indexOf("] = await Promise.all([");

    expect(optionsIndex).toBeGreaterThan(-1);
    expect(queryMapIndex).toBeGreaterThan(optionsIndex);
    expect(filterParamsIndex).toBeGreaterThan(queryMapIndex);
    expect(layoutPromiseIndex).toBeGreaterThan(optionsIndex);
    expect(productsPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(attributesPromiseIndex).toBeGreaterThan(productsPromiseIndex);
    expect(widgetsPromiseIndex).toBeGreaterThan(attributesPromiseIndex);
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

    const optionsIndex = source.indexOf("const productListOptions");
    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const productsPromiseIndex = source.indexOf(
      "const productsPromise = getAllProducts(productListOptions)",
    );
    const attributesPromiseIndex = source.indexOf(
      "const attributesPromise = getFilterableAttributes({ searchQuery: query })",
    );
    const promiseAllIndex = source.indexOf("] = await Promise.all([");

    expect(optionsIndex).toBeGreaterThan(-1);
    expect(layoutPromiseIndex).toBeGreaterThan(optionsIndex);
    expect(productsPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(attributesPromiseIndex).toBeGreaterThan(productsPromiseIndex);
    expect(promiseAllIndex).toBeGreaterThan(attributesPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("productsPromise");
    expect(source.slice(promiseAllIndex)).toContain("attributesPromise");
  });
});
