import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "./test-source-paths";

const STOREFRONT_SRC_ROOT = storefrontSourcePath();

describe("storefront HTML cache policy boundaries", () => {
  it("keeps collection detail pages in the exact HTML cache lane", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/middleware.ts`,
      "utf8",
    );

    const cacheablePathsIndex = source.indexOf("const CACHEABLE_PATHS = [");
    const productsIndex = source.indexOf("/^\\/products\\/[^/]+$/", cacheablePathsIndex);
    const categoriesIndex = source.indexOf("/^\\/categories\\/[^/]+$/", cacheablePathsIndex);
    const collectionsIndex = source.indexOf("/^\\/collections\\/[^/]+$/", cacheablePathsIndex);
    const searchIndex = source.indexOf("/^\\/search\\/?$/", cacheablePathsIndex);

    expect(cacheablePathsIndex).toBeGreaterThan(-1);
    expect(productsIndex).toBeGreaterThan(cacheablePathsIndex);
    expect(categoriesIndex).toBeGreaterThan(productsIndex);
    expect(collectionsIndex).toBeGreaterThan(categoriesIndex);
    expect(searchIndex).toBeGreaterThan(collectionsIndex);
  });

  it("keeps generated public XML/text routes in the edge cache lane", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/middleware.ts`,
      "utf8",
    );

    const cacheablePathsIndex = source.indexOf("const CACHEABLE_PATHS = [");
    expect(cacheablePathsIndex).toBeGreaterThan(-1);
    expect(source).toContain("/^\\/robots\\.txt$/");
    expect(source).toContain("/^\\/sitemap\\.xml$/");
    expect(source).toContain("/^\\/sitemap-.*\\.xml$/");
    expect(source).toContain("/^\\/sitemap\\.xsl$/");
    expect(source).toContain("/^\\/api\\/product-feed\\.xml$/");
    expect(source).toContain("/^\\/api\\/facebook-feed\\.xml$/");
    expect(source).toContain("isCacheablePublicResponse(response)");
  });

  it("preserves public discovery headers when exact generation lookup is unavailable", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/middleware.ts`,
      "utf8",
    );

    const branchStart = source.indexOf("if (!htmlGeneration.cacheEnabled) {");
    const branchEnd = source.indexOf(
      "return await setPageCspHeader(response, env ?? undefined);",
      branchStart,
    );
    const branch = source.slice(branchStart, branchEnd);

    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(branch).toContain("isCacheablePublicResponse(response)");
    expect(branch).toContain("applyBrowserCachePolicyForPublicResponse(response, url.pathname)");
    expect(branch).toContain('"no-cache, no-store, must-revalidate"');
  });

  it("keeps health checks out of the cache and CSP middleware lane", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/middleware.ts`,
      "utf8",
    );

    const fastPathIndex = source.indexOf("const FAST_PASS_THROUGH_PATHS = [");
    const healthPatternIndex = source.indexOf("/^\\/health\\/?$/", fastPathIndex);
    const fastBypassIndex = source.indexOf("BYPASS_FAST", fastPathIndex);
    const cspIndex = source.indexOf("return await setPageCspHeader");

    expect(fastPathIndex).toBeGreaterThan(-1);
    expect(healthPatternIndex).toBeGreaterThan(fastPathIndex);
    expect(fastBypassIndex).toBeGreaterThan(healthPatternIndex);
    expect(cspIndex).toBeGreaterThan(fastBypassIndex);
  });
});
