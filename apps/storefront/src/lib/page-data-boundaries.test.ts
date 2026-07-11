import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "./test-source-paths";

const STOREFRONT_SRC_ROOT = storefrontSourcePath();

function indexAfter(source: string, needle: string, after: number): number {
  const index = source.indexOf(needle, after);
  expect(index).toBeGreaterThan(-1);
  return index;
}

describe("storefront page data boundaries", () => {
  it("keeps product detail reads in the first fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/products/[slug].astro`,
      "utf8",
    );

    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const productPromiseIndex = source.indexOf(
      "const productPromise = getProductBySlug(slug)",
    );
    const shippingPromiseIndex = source.indexOf(
      "const shippingMethodsPromise = getShippingMethods()",
    );
    const promiseAllIndex = source.indexOf(
      "const [layoutData, productData, shippingMethods] = await Promise.all([",
    );

    expect(layoutPromiseIndex).toBeGreaterThan(-1);
    expect(productPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(shippingPromiseIndex).toBeGreaterThan(productPromiseIndex);
    expect(promiseAllIndex).toBeGreaterThan(shippingPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("layoutPromise");
    expect(source.slice(promiseAllIndex)).toContain("productPromise");
    expect(source.slice(promiseAllIndex)).toContain("shippingMethodsPromise");
  });

  it("keeps category cold-cache reads in the first fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/categories/[slug].astro`,
      "utf8",
    );

    const dynamicCheckIndex = source.indexOf(
      "const hasDynamicFilters = hasDynamicProductListFilterParams(params)",
    );
    const paginationHelperIndex = source.indexOf(
      "buildProductListPaginationHref",
    );
    const getPaginationUrlIndex = source.indexOf("function getPaginationUrl");
    const paginationLinksIndex = source.indexOf("function generatePaginationLinks");
    const paginationUrlSource = source.slice(
      getPaginationUrlIndex,
      paginationLinksIndex,
    );
    const optionsIndex = source.indexOf(
      "let productListOptions: ProductListOptions = queryState.options",
    );
    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const attributesPromiseIndex = source.indexOf(
      "const attributesPromise = getFilterableAttributes({ categorySlug: slug })",
    );
    const dynamicBranchIndex = source.indexOf("if (hasDynamicFilters)");
    const dynamicAttributesAwaitIndex = indexAfter(
      source,
      "attributes = (await attributesPromise) || []",
      dynamicBranchIndex,
    );
    const dynamicProductsPromiseIndex = indexAfter(
      source,
      "const productsPromise = getProductsByCategory(slug, productListOptions)",
      dynamicAttributesAwaitIndex,
    );
    const dynamicPromiseAllIndex = indexAfter(
      source,
      "] = await Promise.all([",
      dynamicProductsPromiseIndex,
    );
    const fastBranchIndex = indexAfter(source, "} else {", dynamicPromiseAllIndex);
    const fastProductsPromiseIndex = indexAfter(
      source,
      "const productsPromise = getProductsByCategory(slug, productListOptions)",
      fastBranchIndex,
    );
    const categoryFetchIndex = source.indexOf("getCategoryBySlug");
    const promiseAllIndex = indexAfter(
      source,
      "] = await Promise.all([",
      fastProductsPromiseIndex,
    );

    expect(dynamicCheckIndex).toBeGreaterThan(-1);
    expect(paginationHelperIndex).toBeGreaterThan(-1);
    expect(getPaginationUrlIndex).toBeGreaterThan(-1);
    expect(paginationUrlSource).toContain("currentFilters");
    expect(paginationUrlSource).toContain("productListPathname");
    expect(paginationUrlSource).not.toContain("new URL(");
    expect(source).toContain("buildProductListHref({");
    expect(optionsIndex).toBeGreaterThan(-1);
    expect(layoutPromiseIndex).toBeGreaterThan(optionsIndex);
    expect(attributesPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(dynamicBranchIndex).toBeGreaterThan(attributesPromiseIndex);
    expect(dynamicAttributesAwaitIndex).toBeGreaterThan(dynamicBranchIndex);
    expect(dynamicProductsPromiseIndex).toBeGreaterThan(dynamicAttributesAwaitIndex);
    expect(dynamicProductsPromiseIndex).toBeLessThan(dynamicPromiseAllIndex);
    expect(categoryFetchIndex).toBe(-1);
    expect(promiseAllIndex).toBeGreaterThan(fastProductsPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("productsPromise");
    expect(source.slice(promiseAllIndex)).toContain("attributesPromise");
  });

  it("keeps search cold-cache reads in the first fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/search/index.astro`,
      "utf8",
    );

    const dynamicCheckIndex = source.indexOf(
      "const hasDynamicFilters = hasDynamicProductListFilterParams(params)",
    );
    const paginationHelperIndex = source.indexOf(
      "buildProductListPaginationHref",
    );
    const getPaginationUrlIndex = source.indexOf("function getPaginationUrl");
    const paginationLinksIndex = source.indexOf("function generatePaginationLinks");
    const paginationUrlSource = source.slice(
      getPaginationUrlIndex,
      paginationLinksIndex,
    );
    const optionsIndex = source.indexOf(
      "let productListOptions: ProductListOptions = queryState.options",
    );
    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const attributesPromiseIndex = source.indexOf(
      "const attributesPromise = getFilterableAttributes({ searchQuery: query })",
    );
    const dynamicBranchIndex = source.indexOf("if (hasDynamicFilters)");
    const dynamicAttributesAwaitIndex = indexAfter(
      source,
      "attributes = (await attributesPromise) || []",
      dynamicBranchIndex,
    );
    const dynamicProductsPromiseIndex = indexAfter(
      source,
      "const productsPromise = getAllProducts(productListOptions)",
      dynamicAttributesAwaitIndex,
    );
    const dynamicPromiseAllIndex = indexAfter(
      source,
      "] = await Promise.all([",
      dynamicProductsPromiseIndex,
    );
    const fastBranchIndex = indexAfter(source, "} else {", dynamicPromiseAllIndex);
    const fastProductsPromiseIndex = indexAfter(
      source,
      "const productsPromise = getAllProducts(productListOptions)",
      fastBranchIndex,
    );
    const fastPromiseAllIndex = indexAfter(
      source,
      "] = await Promise.all([",
      fastProductsPromiseIndex,
    );

    expect(dynamicCheckIndex).toBeGreaterThan(-1);
    expect(paginationHelperIndex).toBeGreaterThan(-1);
    expect(getPaginationUrlIndex).toBeGreaterThan(-1);
    expect(paginationUrlSource).toContain("currentFilters");
    expect(paginationUrlSource).toContain("productListPathname");
    expect(paginationUrlSource).not.toContain("new URL(");
    expect(source).toContain("buildProductListHref({");
    expect(optionsIndex).toBeGreaterThan(-1);
    expect(layoutPromiseIndex).toBeGreaterThan(optionsIndex);
    expect(attributesPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(dynamicBranchIndex).toBeGreaterThan(attributesPromiseIndex);
    expect(dynamicAttributesAwaitIndex).toBeGreaterThan(dynamicBranchIndex);
    expect(dynamicProductsPromiseIndex).toBeGreaterThan(dynamicAttributesAwaitIndex);
    expect(dynamicProductsPromiseIndex).toBeLessThan(dynamicPromiseAllIndex);
    expect(fastProductsPromiseIndex).toBeGreaterThan(dynamicPromiseAllIndex);
    expect(fastPromiseAllIndex).toBeGreaterThan(fastProductsPromiseIndex);
    expect(source.slice(fastPromiseAllIndex)).toContain("productsPromise");
    expect(source.slice(fastPromiseAllIndex)).toContain("attributesPromise");
  });

  it("tracks search result pages with Search analytics instead of ViewContent", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/search/index.astro`,
      "utf8",
    );

    expect(source).toContain(
      'import { trackStorefrontSearchResults } from "@/lib/analytics";',
    );
    expect(source).toContain("trackStorefrontSearchResults({");
    expect(source).not.toContain("trackFbViewContent");
    expect(source).not.toContain("viewContentTracked");
  });

  it("fails cacheable listing/home pages closed when required backend data is missing", () => {
    const homepageSource = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/index.astro`,
      "utf8",
    );
    const productSource = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/products/[slug].astro`,
      "utf8",
    );
    const searchSource = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/search/index.astro`,
      "utf8",
    );
    const categorySource = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/categories/[slug].astro`,
      "utf8",
    );
    const cmsPageSource = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/[slug].astro`,
      "utf8",
    );
    const collectionSource = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/collections/[id].astro`,
      "utf8",
    );

    expect(homepageSource).toContain("storefrontDataUnavailableResponse");
    expect(homepageSource).toContain("if (!layoutData || !homepageData)");
    expect(productSource).toContain("storefrontDataUnavailableResponse");
    expect(productSource).toContain("if (!layoutData)");
    expect(productSource).toContain(
      "const response = storefrontDataUnavailableResponse(\n    \"We could not load this product. Please try again shortly.\"",
    );
    expect(searchSource).toContain("storefrontDataUnavailableResponse");
    expect(searchSource).toContain("if (!layoutData || !productsResponse)");
    expect(categorySource).toContain("storefrontDataUnavailableResponse");
    expect(categorySource).toContain(
      "if (!layoutData || !productsResponse || !productsResponse.category)",
    );
    expect(categorySource).toContain(
      "const response = storefrontDataUnavailableResponse(\n      \"We could not load this category. Please try again shortly.\"",
    );
    expect(cmsPageSource).toContain("storefrontDataUnavailableResponse");
    expect(cmsPageSource).toContain("if (!layoutData)");
    expect(cmsPageSource).toContain(
      "const response = storefrontDataUnavailableResponse(\n    \"We could not load this page. Please try again shortly.\"",
    );
    expect(collectionSource).toContain("storefrontDataUnavailableResponse");
    expect(collectionSource).toContain("if (!layoutData)");
    expect(collectionSource).toContain(
      "const response = storefrontDataUnavailableResponse(\n    \"We could not load this collection. Please try again shortly.\"",
    );
  });

  it("uses the consolidated CMS page render endpoint", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/[slug].astro`,
      "utf8",
    );

    expect(source).toContain("getPageRenderData(slug)");
    expect(source).toContain("const page = pageRenderData?.page ?? null");
  });
});
