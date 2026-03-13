// src/server/routes/products.ts
// Storefront product routes — thin HTTP layer.
// All query logic lives in src/modules/products/products.service.ts.
import { Hono } from "hono";
import { z } from "zod";
import { cacheMiddleware } from "../middleware/cache";
import {
  getStorefrontProducts,
  getStorefrontProductBySlug,
  searchStorefrontProducts,
} from "@scalius/core/modules/products/products.service";

const app = new Hono();

app.use(
  "*",
  cacheMiddleware({
    ttl: 3600,
    keyPrefix: "api:products:",
    varyByQuery: true,
    methods: ["GET"],
  }),
);

const productFilterSchema = z.object({
  category: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().optional().default(1),
  limit: z.coerce.number().optional().default(20),
  sort: z
    .enum(["newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount"])
    .optional()
    .default("newest"),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
  ids: z.string().optional(),
});

const productSearchSchema = z.object({
  search: z.string().optional().default(""),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

// GET /api/storefront/products
app.get("/", async (c) => {
  try {
    const db = c.get("db");
    const params = productFilterSchema.parse(c.req.query());
    const queryParams = c.req.query();

    // Resolve attribute filters from unknown query params
    const attributeFilters = await getAttributeFilters(db, queryParams, params);

    const result = await getStorefrontProducts(db, { ...params, attributeFilters });
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("Error fetching storefront products:", error);
    return c.json({ success: false, error: "Failed to fetch products" }, 500);
  }
});

// GET /api/storefront/products/search
// Variant-aware product search used by cart/checkout. Returns lightweight variant data.
app.get("/search", async (c) => {
  try {
    const db = c.get("db");
    const { search, page, limit } = productSearchSchema.parse(c.req.query());
    const result = await searchStorefrontProducts(db, { search, page, limit });
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("Error searching products:", error);
    return c.json({ success: false, error: "Failed to search products" }, 500);
  }
});

// GET /api/storefront/products/:slug
app.get("/:slug", async (c) => {
  try {
    const db = c.get("db");
    const { slug } = c.req.param();
    const result = await getStorefrontProductBySlug(db, slug);
    if (!result) return c.json({ success: false, error: "Product not found" }, 404);
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("Error fetching storefront product by slug:", error);
    return c.json({ success: false, error: "Failed to fetch product" }, 500);
  }
});

/** Extracts attribute-based filters from raw query params by checking known attribute slugs. */
async function getAttributeFilters(
  db: any,
  queryParams: Record<string, string>,
  parsedParams: ReturnType<typeof productFilterSchema.parse>,
): Promise<Array<{ slug: string; value: string }>> {
  const knownKeys = new Set(Object.keys(parsedParams));
  const potentialAttributeKeys = Object.keys(queryParams).filter((k) => !knownKeys.has(k));
  if (potentialAttributeKeys.length === 0) return [];

  const { productAttributes } = await import("@scalius/database/schema");
  const { inArray } = await import("drizzle-orm");

  const allAttributes: Array<{ slug: string }> = await db
    .select({ slug: productAttributes.slug })
    .from(productAttributes)
    .where(inArray(productAttributes.slug, potentialAttributeKeys));

  const validSlugs = new Set(allAttributes.map((a) => a.slug));
  return potentialAttributeKeys
    .filter((k) => validSlugs.has(k) && queryParams[k])
    .map((k) => ({ slug: k, value: queryParams[k] }));
}

export { app as productRoutes };
