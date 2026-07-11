import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

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
    expect(source).toContain("category: z.string().optional().openapi({ description: \"Category slug or ID filter\" })");
    expect(source).toContain("return isPublicProductSearchCacheable(c.req.url);");
    expect(source).toContain("return isPublicProductListCacheable(c.req.url);");
    expect(source).toContain("const search = normalizePublicListingSearchParam(params.search);");
    expect(source).toContain("getStorefrontProducts(db, { ...params, search, attributeFilters })");
    expect(source).toContain("400: errorResponses[400]");
  });

  it("keeps feed projection on a dedicated route without expanding normal product list cards", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");
    const listSchemaStart = source.indexOf("const storefrontProductSchema = z.object({");
    const feedSchemaStart = source.indexOf("const storefrontFeedProductSchema = z.object({");
    const listRouteStart = source.indexOf("const listProductsRoute = createRoute({");
    const feedRouteStart = source.indexOf("const feedProductsRoute = createRoute({");
    const slugRouteStart = source.indexOf("const getProductBySlugRoute = createRoute({");

    expect(source).toContain("getStorefrontFeedProducts");
    expect(source).toContain("const PRODUCT_FEED_QUERY_KEYS = new Set([\"page\", \"limit\", \"sort\", \"category\", \"search\", \"minPrice\", \"maxPrice\", \"ids\"]);");
    expect(source).toContain("function isStorefrontFeedProductsCacheable(url: string): boolean");
    expect(source).toContain("if (!PRODUCT_FEED_QUERY_KEYS.has(key)) return false;");
    expect(source).toContain("if (value.trim() === \"\" && key !== \"search\") return false;");
    expect(source).toContain("hasOptionalFiniteNumberParam(params, \"minPrice\")");
    expect(source).toContain("hasOptionalFiniteNumberParam(params, \"maxPrice\")");
    expect(source).toContain("if (normalizedPath.endsWith(\"/products/feed\"))");
    expect(source).toContain("return { page: 1, limit: 100, sort: \"newest\" };");
    expect(source).toContain("return isStorefrontFeedProductsCacheable(c.req.url);");
    expect(source).toContain("const productFeedSchema = z.object({");
    expect(source).toContain("category: z.string().optional().openapi({ description: \"Category slug or ID filter\" })");
    expect(source).toContain("search: z.string().optional().openapi({ description: \"Search query\" })");
    expect(source).toContain("minPrice: z.coerce.number().optional().openapi({ description: \"Minimum price filter\" })");
    expect(source).toContain("maxPrice: z.coerce.number().optional().openapi({ description: \"Maximum price filter\" })");
    expect(source).toContain("description: \"Comma-separated product IDs, product handles, variant IDs, or SKUs\"");
    expect(source).toContain("limit: z.coerce.number().int().min(1).max(100).optional().default(100)");
    expect(source).toContain("path: \"/feed\"");
    expect(source).toContain("const search = normalizePublicListingSearchParam(params.search);");
    expect(source).toContain("getStorefrontFeedProducts(db, { ...params, search })");
    expect(feedRouteStart).toBeGreaterThan(listRouteStart);
    expect(slugRouteStart).toBeGreaterThan(feedRouteStart);

    const listSchema = source.slice(listSchemaStart, feedSchemaStart);
    const feedSchema = source.slice(feedSchemaStart, source.indexOf("const productDetailRecordSchema", feedSchemaStart));
    expect(listSchema).not.toContain("description:");
    expect(listSchema).not.toContain("attributes:");
    expect(listSchema).not.toContain("variants:");
    expect(feedSchema).toContain("canonicalPath: z.string().nullable()");
    expect(feedSchema).toContain("description: z.string().nullable()");
    expect(feedSchema).toContain("attributes: z.array(storefrontFeedAttributeSchema)");
    expect(feedSchema).toContain("variants: z.array(storefrontFeedVariantSchema)");
  });

  it("keeps category-term feed search on the normalized cached projection", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");
    const feedHandlerStart = source.indexOf(
      "app.openapi(feedProductsRoute, async (c) => {",
    );
    const sitemapRouteStart = source.indexOf(
      "// GET /api/v1/products/sitemap",
      feedHandlerStart,
    );
    const feedHandler = source.slice(feedHandlerStart, sitemapRouteStart);

    expect(source).toContain("search: normalizePublicFtsSearchCacheValue");
    expect(source).toContain(
      'if (normalizedPath.endsWith("/products/feed"))',
    );
    expect(source).toContain(
      'return { page: 1, limit: 100, sort: "newest" };',
    );
    expect(feedHandler).toContain(
      "const search = normalizePublicListingSearchParam(params.search);",
    );
    expect(feedHandler).toContain(
      "getStorefrontFeedProducts(db, { ...params, search })",
    );
    expect(feedHandler).not.toContain("categories");
    expect(feedHandler).not.toContain(".limit(");
  });

  it("documents feed variants with only buyer-safe fields", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");
    const variantSchemaStart = source.indexOf("const storefrontFeedVariantSchema = z.object({");
    const variantSchemaEnd = source.indexOf("const storefrontFeedAttributeSchema", variantSchemaStart);
    const variantSchema = source.slice(variantSchemaStart, variantSchemaEnd);

    expect(variantSchema).toContain("id: z.string()");
    expect(variantSchema).toContain("productId: z.string()");
    expect(variantSchema).toContain("size: z.string().nullable()");
    expect(variantSchema).toContain("color: z.string().nullable()");
    expect(variantSchema).toContain("weight: z.number().nullable()");
    expect(variantSchema).toContain("sku: z.string()");
    expect(variantSchema).toContain("price: z.number()");
    expect(variantSchema).toContain("stock: z.number()");
    expect(variantSchema).toContain("reservedStock: z.number()");
    expect(variantSchema).toContain("isDefault: z.boolean()");
    expect(variantSchema).toContain("trackInventory: z.boolean()");
    expect(variantSchema).toContain("barcode: z.string().nullable()");
    expect(variantSchema).toContain("barcodeType: z.string().nullable()");
    expect(variantSchema).toContain("discountType: z.string().nullable()");
    expect(variantSchema).toContain("discountPercentage: z.number().nullable()");
    expect(variantSchema).toContain("discountAmount: z.number().nullable()");
    expect(variantSchema).toContain("colorSortOrder: z.number().nullable()");
    expect(variantSchema).toContain("sizeSortOrder: z.number().nullable()");
    expect(variantSchema).toContain("deletedAt: z.string().nullable()");
    expect(variantSchema).not.toContain("createdAt");
    expect(variantSchema).not.toContain("updatedAt");
  });

  it("normalizes product lookup search before variant-aware storefront search", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");

    expect(source).toContain("page: z.coerce.number().int().min(1).max(1000).optional().default(1)");
    expect(source).toContain("const normalizedSearch = normalizePublicListingSearchParam(search) ?? \"\";");
    expect(source).toContain("searchStorefrontProducts(db, { search: normalizedSearch, page, limit })");
  });
});
