import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("product route query boundaries", () => {
  it("delegates public attribute query filter resolution to core without route-local dynamic imports", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");

    const resolverImportIndex = source.indexOf("resolvePublicAttributeFilters");
    const resolverCallIndex = source.indexOf(
      "const attributeFilters = await resolvePublicAttributeFilters(",
    );

    expect(resolverImportIndex).toBeGreaterThan(-1);
    expect(resolverCallIndex).toBeGreaterThan(resolverImportIndex);
    expect(source).not.toContain("async function getAttributeFilters");
    expect(source).not.toContain('await import("@scalius/database/schema")');
    expect(source).not.toContain('await import("drizzle-orm")');
  });

  it("bounds public product list limits and normalizes search cache keys", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");

    expect(source).toContain("page: z.coerce.number().int().min(1).max(1000).optional().default(1)");
    expect(source).toContain("limit: z.coerce.number().int().min(1).max(100).optional().default(20)");
    expect(source).toContain("queryNormalizers: {");
    expect(source).toContain("search: normalizePublicFtsSearchCacheValue");
    expect(source).toContain("limit: normalizePublicIntegerCacheValue");
    expect(source).toContain("cacheCondition: (c) => {");
    expect(source).toContain("return isPublicProductSearchCacheable(c.req.url);");
    expect(source).toContain("return isPublicProductListCacheable(c.req.url);");
    expect(source).toContain("const search = normalizePublicListingSearchParam(params.search);");
    expect(source).toContain("getStorefrontProducts(db, { ...params, search, attributeFilters })");
    expect(source).toContain("400: errorResponses[400]");
  });

  it("normalizes product lookup search before variant-aware storefront search", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");

    expect(source).toContain("page: z.coerce.number().int().min(1).max(1000).optional().default(1)");
    expect(source).toContain("const normalizedSearch = normalizePublicListingSearchParam(search) ?? \"\";");
    expect(source).toContain("searchStorefrontProducts(db, { search: normalizedSearch, page, limit })");
  });
});
