// src/server/routes/products.ts
// Storefront product routes — thin HTTP layer.
// All main query logic lives in src/modules/products/products.service.ts.
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { products, productAttributes, productVariants, productImages } from "@/db/schema";
import { eq, and, isNull, desc, inArray, sql } from "drizzle-orm";
import { ftsMatch } from "@/lib/search/fts5";
import { cacheMiddleware } from "../middleware/cache";
import {
  getStorefrontProducts,
  getStorefrontProductBySlug,
} from "@/modules/products/products.service";

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
    const params = productFilterSchema.parse(c.req.query());
    const queryParams = c.req.query();

    // Resolve attribute filters from unknown query params
    const allAttributes = await db
      .select({ slug: productAttributes.slug })
      .from(productAttributes);
    const validAttributeSlugs = new Set(allAttributes.map((a) => a.slug));
    const attributeFilters: { slug: string; value: string }[] = [];
    for (const key in queryParams) {
      if (validAttributeSlugs.has(key)) {
        const value = queryParams[key];
        if (value) attributeFilters.push({ slug: key, value });
      }
    }

    const result = await getStorefrontProducts({ ...params, attributeFilters });
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("Error fetching storefront products:", error);
    return c.json({ success: false, error: "Failed to fetch products" }, 500);
  }
});

// GET /api/storefront/products/:slug
app.get("/:slug", async (c) => {
  try {
    const { slug } = c.req.param();
    const result = await getStorefrontProductBySlug(slug);
    if (!result) return c.json({ success: false, error: "Product not found" }, 404);
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("Error fetching storefront product by slug:", error);
    return c.json({ success: false, error: "Failed to fetch product" }, 500);
  }
});

// GET /api/storefront/products/search
// Variant-aware product search used by cart/checkout. Returns lightweight variant data.
app.get("/search", async (c) => {
  try {
    const { search, page, limit } = productSearchSchema.parse(c.req.query());

    const conditions: any[] = [eq(products.isActive, true), isNull(products.deletedAt)];
    const searchCondition = search ? ftsMatch("products_fts", "products", search) : null;
    if (searchCondition) conditions.push(searchCondition);

    const offset = (page - 1) * limit;

    const [results, [countResult]] = await Promise.all([
      db
        .select({
          id: products.id,
          name: products.name,
          price: products.price,
          slug: products.slug,
          discountType: products.discountType,
          discountPercentage: products.discountPercentage,
          discountAmount: products.discountAmount,
          freeDelivery: products.freeDelivery,
        })
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.updatedAt))
        .limit(limit)
        .offset(offset)
        .all(),
      db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions)),
    ]);

    const productIds = results.map((p) => p.id);

    const [images, variants] =
      productIds.length > 0
        ? await Promise.all([
          db
            .select({ productId: productImages.productId, url: productImages.url })
            .from(productImages)
            .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds))),
          db
            .select({
              id: productVariants.id,
              productId: productVariants.productId,
              size: productVariants.size,
              color: productVariants.color,
              weight: productVariants.weight,
              sku: productVariants.sku,
              price: productVariants.price,
              stock: productVariants.stock,
              discountType: productVariants.discountType,
              discountPercentage: productVariants.discountPercentage,
              discountAmount: productVariants.discountAmount,
              colorSortOrder: productVariants.colorSortOrder,
              sizeSortOrder: productVariants.sizeSortOrder,
            })
            .from(productVariants)
            .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
            .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder),
        ])
        : [[], []];

    const imageMap = new Map(images.map((img) => [img.productId, img.url]));
    const count = Number(countResult?.count || 0);
    const totalPages = Math.ceil(count / limit);

    return c.json({
      success: true,
      data: results.map((product) => ({
        ...product,
        imageUrl: imageMap.get(product.id) || null,
        variants: variants.filter((v) => v.productId === product.id),
      })),
      pagination: {
        page, limit, total: count, totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Error searching products:", error);
    return c.json({ success: false, error: "Failed to search products" }, 500);
  }
});

export { app as productRoutes };
