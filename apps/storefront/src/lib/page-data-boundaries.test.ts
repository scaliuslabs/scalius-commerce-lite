import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "./test-source-paths";

const STOREFRONT_SRC_ROOT = storefrontSourcePath();
const catalogSortSource = readFileSync(
  `${STOREFRONT_SRC_ROOT}/lib/catalog-sort.ts`,
  "utf8",
);

describe("storefront page data boundaries", () => {
  it("uses the cart title as the page's primary heading", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/cart.astro`,
      "utf8",
    );

    expect(source).toContain(
      '<h1 class="text-[1.25rem] font-bold leading-tight text-foreground sm:text-2xl">',
    );
    expect(source).not.toContain(
      '<h2 class="text-[1.25rem] font-bold leading-tight text-foreground sm:text-2xl">',
    );
  });

  it("keeps product detail reads in the first fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/products/[slug].astro`,
      "utf8",
    );

    const layoutPromiseIndex = source.indexOf(
      "const layoutPromise = getLayoutData()",
    );
    const productPromiseIndex = source.indexOf(
      "const productPromise = getProductBySlugResult(slug)",
    );
    const shippingPromiseIndex = source.indexOf(
      "const shippingMethodsPromise = getShippingMethods()",
    );
    const promiseAllIndex = source.indexOf(
      "const [layoutData, productResult, shippingMethods] = await Promise.all([",
    );

    expect(layoutPromiseIndex).toBeGreaterThan(-1);
    expect(productPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(shippingPromiseIndex).toBeGreaterThan(productPromiseIndex);
    expect(promiseAllIndex).toBeGreaterThan(shippingPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("layoutPromise");
    expect(source.slice(promiseAllIndex)).toContain("productPromise");
    expect(source.slice(promiseAllIndex)).toContain("shippingMethodsPromise");
  });

  it("loads category products and result-scoped facets in one catalog response", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/categories/[slug].astro`,
      "utf8",
    );

    const paginationHelperIndex = source.indexOf(
      "buildProductListPaginationHref",
    );
    const getPaginationUrlIndex = source.indexOf("function getPaginationUrl");
    const paginationLinksIndex = source.indexOf(
      "function generatePaginationLinks",
    );
    const paginationUrlSource = source.slice(
      getPaginationUrlIndex,
      paginationLinksIndex,
    );
    const optionsIndex = source.indexOf(
      "const productListOptions: ProductListOptions = initialQueryState.options",
    );
    const promiseAllIndex = source.indexOf(
      "[layoutData, productsResponse] = await Promise.all([",
    );
    const categoryFetchIndex = source.indexOf("getCategoryBySlug");

    expect(paginationHelperIndex).toBeGreaterThan(-1);
    expect(getPaginationUrlIndex).toBeGreaterThan(-1);
    expect(paginationUrlSource).toContain("currentFilters");
    expect(paginationUrlSource).toContain("productListPathname");
    expect(paginationUrlSource).not.toContain("new URL(");
    expect(source).toContain("setupCatalogSorts");
    expect(catalogSortSource).toContain("buildProductListHref({");
    expect(optionsIndex).toBeGreaterThan(-1);
    expect(categoryFetchIndex).toBe(-1);
    expect(promiseAllIndex).toBeGreaterThan(optionsIndex);
    expect(source.slice(promiseAllIndex)).toContain("getLayoutData()");
    expect(source.slice(promiseAllIndex)).toContain(
      "getProductsByCategory(slug, productListOptions)",
    );
    expect(source).toContain(
      "const facets: ProductFacet[] = productsResponse.facets ?? []",
    );
    expect(source).not.toContain("getFilterableAttributes");
  });

  it("loads search products and result-scoped facets in one catalog response", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/search/index.astro`,
      "utf8",
    );

    const paginationHelperIndex = source.indexOf(
      "buildProductListPaginationHref",
    );
    const getPaginationUrlIndex = source.indexOf("function getPaginationUrl");
    const paginationLinksIndex = source.indexOf(
      "function generatePaginationLinks",
    );
    const paginationUrlSource = source.slice(
      getPaginationUrlIndex,
      paginationLinksIndex,
    );
    const optionsIndex = source.indexOf(
      "const productListOptions: ProductListOptions = initialQueryState.options",
    );
    const promiseAllIndex = source.indexOf(
      "[layoutData, productsResponse] = await Promise.all([",
    );

    expect(paginationHelperIndex).toBeGreaterThan(-1);
    expect(getPaginationUrlIndex).toBeGreaterThan(-1);
    expect(paginationUrlSource).toContain("currentFilters");
    expect(paginationUrlSource).toContain("productListPathname");
    expect(paginationUrlSource).not.toContain("new URL(");
    expect(source).toContain("setupCatalogSorts");
    expect(catalogSortSource).toContain("buildProductListHref({");
    expect(optionsIndex).toBeGreaterThan(-1);
    expect(promiseAllIndex).toBeGreaterThan(optionsIndex);
    expect(source.slice(promiseAllIndex)).toContain("getLayoutData()");
    expect(source.slice(promiseAllIndex)).toContain(
      "getAllProducts(productListOptions)",
    );
    expect(source).toContain(
      "const facets: ProductFacet[] = productsResponse.facets ?? []",
    );
    expect(source).not.toContain("getFilterableAttributes");
  });

  it("tracks search result pages with Search analytics instead of ViewContent", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/search/index.astro`,
      "utf8",
    );

    expect(source).toContain(
      'const { trackStorefrontSearchResults } = await import("@/lib/analytics");',
    );
    expect(source).toContain("scheduleNonCriticalAnalytics(");
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
    expect(productSource).toContain('if (productResult.state === "not_found")');
    expect(productSource).toContain(
      'if (productResult.state === "unavailable" || !layoutData)',
    );
    expect(productSource).toContain(
      'const response = storefrontDataUnavailableResponse(\n    "We could not load this product. Please try again shortly."',
    );
    expect(searchSource).toContain("storefrontDataUnavailableResponse");
    expect(searchSource).toContain("if (!layoutData || !productsResponse)");
    expect(categorySource).toContain("storefrontDataUnavailableResponse");
    expect(categorySource).toContain(
      "if (!layoutData || !productsResponse || !productsResponse.category)",
    );
    expect(categorySource).toContain(
      'const response = storefrontDataUnavailableResponse(\n      "We could not load this category. Please try again shortly."',
    );
    expect(cmsPageSource).toContain("storefrontDataUnavailableResponse");
    expect(cmsPageSource).toContain("if (!layoutData)");
    expect(cmsPageSource).toContain(
      'const response = storefrontDataUnavailableResponse(\n    "We could not load this page. Please try again shortly."',
    );
    expect(collectionSource).toContain("storefrontDataUnavailableResponse");
    expect(collectionSource).toContain(
      'if (collectionResult.state === "not_found")',
    );
    expect(collectionSource).toContain(
      'if (collectionResult.state === "unavailable" || !layoutData)',
    );
    expect(collectionSource).toContain(
      'const response = storefrontDataUnavailableResponse(\n    "We could not load this collection. Please try again shortly."',
    );
  });

  it("gives the homepage one stable storefront-identity heading", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/index.astro`,
      "utf8",
    );
    const headingSource = source.slice(
      source.indexOf("const homepageHeading ="),
      source.indexOf("import { DEFAULT_CURRENCY }"),
    );

    expect(source).toContain("const homepageHeading =");
    expect(headingSource.indexOf("seo.siteTitle?.trim()")).toBeLessThan(
      headingSource.indexOf("layoutData.business?.companyName?.trim()"),
    );
    expect(headingSource).toContain("layoutData.business?.legalName?.trim()");
    expect(source).toContain('<h1 class="sr-only">{homepageHeading}</h1>');
  });

  it("preloads only the first viewport-matched homepage hero", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/index.astro`,
      "utf8",
    );

    expect(source).toContain("const desktopHeroPreload =");
    expect(source).toContain("const mobileHeroPreload =");
    expect(source).toContain('media="(max-width: 767px)"');
    expect(source).toContain('media="(min-width: 768px)"');
    expect(source.match(/rel="preload"/g)).toHaveLength(2);
    expect(source.match(/fetchpriority="high"/g)).toHaveLength(2);
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
