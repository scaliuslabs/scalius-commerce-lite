// src/server/routes/products.ts
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import {
  products,
  productImages,
  categories,
  productVariants,
  productAttributes,
  productAttributeValues,
  productRichContent,
} from "@/db/schema";
import { eq, sql, and, isNull, desc, like, inArray, or } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

const app = new Hono();

app.use(
  "*",
  cacheMiddleware({
    // Increased TTL to 1 hour (3600s).
    // This allows browser/CDN caching (max-age=300) and reduces Redis/DB load.
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
    .enum([
      "newest",
      "price-asc",
      "price-desc",
      "name-asc",
      "name-desc",
      "discount",
    ])
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

const unixToDate = (timestamp: number | null): Date | null => {
  if (timestamp === null || timestamp === undefined) return null;
  return new Date(timestamp * 1000);
};

function extractFeatures(description: string | null): string[] {
  if (!description) return [];
  const features: string[] = [];
  const lines = description.split("\n");
  for (const line of lines) {
    if (line.trim().match(/^[-*•]|^\d+\./) && line.trim().length > 2) {
      features.push(
        line
          .trim()
          .replace(/^[-*•]|^\d+\./, "")
          .trim(),
      );
    }
  }
  return features;
}

function calculateDiscountedPrice(
  price: number,
  discountType: string | null,
  discountPercentage: number | null,
  discountAmount: number | null,
): number {
  if (discountType === "flat" && discountAmount) {
    return Math.max(0, Math.round(price - discountAmount));
  } else if (discountType === "percentage" && discountPercentage) {
    return Math.round(price * (1 - discountPercentage / 100));
  }
  return price;
}

app.get("/", async (c) => {
  try {
    const params = productFilterSchema.parse(c.req.query());
    const {
      category,
      search,
      page,
      limit,
      sort,
      minPrice,
      maxPrice,
      freeDelivery,
      hasDiscount,
      ids,
    } = params;

    const queryParams = c.req.query();
    const allAttributes = await db
      .select({ slug: productAttributes.slug })
      .from(productAttributes);
    const validAttributeSlugs = new Set(allAttributes.map((a) => a.slug));
    const attributeFilters: { slug: string; value: string }[] = [];

    for (const key in queryParams) {
      if (validAttributeSlugs.has(key)) {
        const value = queryParams[key];
        if (value) {
          attributeFilters.push({ slug: key, value });
        }
      }
    }

    const conditions = [
      eq(products.isActive, true),
      isNull(products.deletedAt),
    ];

    if (category) {
      conditions.push(eq(products.categoryId, category));
    }
    if (search) {
      conditions.push(like(products.name, `%${search}%`));
    }
    if (minPrice !== undefined) {
      conditions.push(sql`${products.price} >= ${minPrice}`);
    }
    if (maxPrice !== undefined) {
      conditions.push(sql`${products.price} <= ${maxPrice}`);
    }
    if (freeDelivery === "true") {
      conditions.push(eq(products.freeDelivery, true));
    } else if (freeDelivery === "false") {
      conditions.push(eq(products.freeDelivery, false));
    }
    if (hasDiscount === "true") {
      conditions.push(sql`${products.discountPercentage} > 0`);
    } else if (hasDiscount === "false") {
      conditions.push(
        sql`${products.discountPercentage} = 0 OR ${products.discountPercentage} IS NULL`,
      );
    }
    if (ids) {
      const productIds = ids.split(",");
      conditions.push(inArray(products.id, productIds));
    }

    let orderBy;
    if (sort === "price-asc") {
      orderBy = sql`CASE WHEN ${products.discountPercentage} > 0 THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100)) ELSE ${products.price} END`;
    } else if (sort === "price-desc") {
      orderBy = desc(
        sql`CASE WHEN ${products.discountPercentage} > 0 THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100)) ELSE ${products.price} END`,
      );
    } else if (sort === "name-asc") {
      orderBy = products.name;
    } else if (sort === "name-desc") {
      orderBy = desc(products.name);
    } else if (sort === "discount") {
      orderBy = desc(products.discountPercentage);
    } else {
      orderBy = desc(products.createdAt);
    }

    const offset = (page - 1) * limit;

    let query = db
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        slug: products.slug,
        discountType: products.discountType,
        discountPercentage: products.discountPercentage,
        discountAmount: products.discountAmount,
        freeDelivery: products.freeDelivery,
        categoryId: products.categoryId,
        createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as(
          "createdAt",
        ),
        updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as(
          "updatedAt",
        ),
        // --- FIX: Count the joined variants. This will be 0 for products without variants. ---
        variantCount: sql<number>`count(${productVariants.id})`.as(
          "variantCount",
        ),
      })
      .from(products)
      .where(and(...conditions))
      // --- FIX: Use a LEFT JOIN to include all products, even those with no variants. ---
      .leftJoin(
        productVariants,
        and(
          eq(products.id, productVariants.productId),
          isNull(productVariants.deletedAt),
        ),
      )
      // --- FIX: Group by all product fields to get one row per product. ---
      .groupBy(
        products.id,
        products.name,
        products.price,
        products.slug,
        products.discountType,
        products.discountPercentage,
        products.discountAmount,
        products.freeDelivery,
        products.categoryId,
        products.createdAt,
        products.updatedAt,
      );

    if (attributeFilters.length > 0) {
      const subquery = db
        .select({ productId: productAttributeValues.productId })
        .from(productAttributeValues)
        .leftJoin(
          productAttributes,
          eq(productAttributeValues.attributeId, productAttributes.id),
        )
        .where(
          or(
            ...attributeFilters.map((filter) =>
              and(
                eq(productAttributes.slug, filter.slug),
                eq(productAttributeValues.value, filter.value),
              ),
            ),
          ),
        )
        .groupBy(productAttributeValues.productId)
        .having(sql`count(*) = ${attributeFilters.length}`)
        .as("filtered_products");

      query = query.innerJoin(subquery, eq(products.id, subquery.productId));
    }

    const productsList = await query
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset)
      .all();

    const productIds = productsList.map((p) => p.id);

    let imageMap = new Map();
    if (productIds.length > 0) {
      const images = await db
        .select({ productId: productImages.productId, url: productImages.url })
        .from(productImages)
        .where(
          and(
            eq(productImages.isPrimary, true),
            inArray(productImages.productId, productIds),
          ),
        )
        .all();
      imageMap = new Map(images.map((img) => [img.productId, img.url]));
    }

    let categoryMap = new Map();
    if (productIds.length > 0) {
      const categoryIds = [
        ...new Set(productsList.map((p) => p.categoryId).filter(Boolean)),
      ] as string[];
      if (categoryIds.length > 0) {
        const categoriesData = await db
          .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
          })
          .from(categories)
          .where(inArray(categories.id, categoryIds))
          .all();
        categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));
      }
    }

    const productsWithImages = productsList.map(
      ({ variantCount, ...product }) => ({
        ...product,
        // --- FIX: Convert the variantCount to a boolean for the final JSON response. ---
        hasVariants: variantCount > 0,
        imageUrl: imageMap.get(product.id) || null,
        category: product.categoryId
          ? categoryMap.get(product.categoryId) || null
          : null,
        createdAt: unixToDate(product.createdAt)?.toISOString() || null,
        updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        discountedPrice: calculateDiscountedPrice(
          product.price,
          product.discountType,
          product.discountPercentage,
          product.discountAmount,
        ),
      }),
    );

    let countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(and(...conditions));

    if (attributeFilters.length > 0) {
      const countSubquery = db
        .select({ productId: productAttributeValues.productId })
        .from(productAttributeValues)
        .leftJoin(
          productAttributes,
          eq(productAttributeValues.attributeId, productAttributes.id),
        )
        .where(
          or(
            ...attributeFilters.map((filter) =>
              and(
                eq(productAttributes.slug, filter.slug),
                eq(productAttributeValues.value, filter.value),
              ),
            ),
          ),
        )
        .groupBy(productAttributeValues.productId)
        .having(sql`count(*) = ${attributeFilters.length}`)
        .as("count_filtered_products");
      countQuery = countQuery.innerJoin(
        countSubquery,
        eq(products.id, countSubquery.productId),
      );
    }

    const totalCount = await countQuery.get();

    return c.json({
      products: productsWithImages,
      pagination: {
        page,
        limit,
        total: totalCount?.count || 0,
        totalPages: Math.ceil((totalCount?.count || 0) / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return c.json({ error: "Failed to fetch products" }, 500);
  }
});

// ... (The rest of the file remains unchanged as it was already correct)
app.get("/:slug", async (c) => {
  try {
    const slug = c.req.param("slug");

    // 1. Fetch the product first, as other queries depend on it
    const product = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        categoryId: products.categoryId,
        slug: products.slug,
        metaTitle: products.metaTitle,
        metaDescription: products.metaDescription,
        discountType: products.discountType,
        discountPercentage: products.discountPercentage,
        discountAmount: products.discountAmount,
        freeDelivery: products.freeDelivery,
        isActive: products.isActive,
        deletedAt: sql<number | null>`CAST(${products.deletedAt} AS INTEGER)`,
        createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
      })
      .from(products)
      .where(
        and(
          eq(products.slug, slug),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      )
      .get();

    if (!product) {
      return c.json({ error: "Product not found" }, 404);
    }

    // --- PARALLEL QUERY EXECUTION START ---
    // Fetch all related data in parallel using Promise.all

    // We can define the promises array
    const promises = [];

    // 1. Images Promise
    promises.push(
      db
        .select({
          id: productImages.id,
          productId: productImages.productId,
          url: productImages.url,
          alt: productImages.alt,
          isPrimary: productImages.isPrimary,
          sortOrder: productImages.sortOrder,
          createdAt: sql<number>`CAST(${productImages.createdAt} AS INTEGER)`,
        })
        .from(productImages)
        .where(eq(productImages.productId, product.id))
        .orderBy(productImages.sortOrder)
        .all()
        .then((res) => ({ type: "images", data: res })),
    );

    // 2. Variants Promise
    promises.push(
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
          createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
          updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
          deletedAt: sql<
            number | null
          >`CAST(${productVariants.deletedAt} AS INTEGER)`,
        })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.productId, product.id),
            isNull(productVariants.deletedAt),
          ),
        )
        .orderBy(
          productVariants.colorSortOrder,
          productVariants.sizeSortOrder,
          productVariants.createdAt,
        )
        .all()
        .then((res) => ({ type: "variants", data: res })),
    );

    // 3. Category Promise (Conditional)
    if (product.categoryId) {
      promises.push(
        db
          .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            description: categories.description,
            imageUrl: categories.imageUrl,
            metaTitle: categories.metaTitle,
            metaDescription: categories.metaDescription,
          })
          .from(categories)
          .where(eq(categories.id, product.categoryId))
          .get()
          .then((res) => ({ type: "category", data: res })),
      );
    }

    // 4. Additional Info Promise
    promises.push(
      db
        .select({
          id: productRichContent.id,
          title: productRichContent.title,
          content: productRichContent.content,
        })
        .from(productRichContent)
        .where(eq(productRichContent.productId, product.id))
        .orderBy(productRichContent.sortOrder)
        .then((res) => ({ type: "additionalInfo", data: res })),
    );

    // 5. Related Products Promise (Conditional)
    if (product.categoryId) {
      // We do fetch related products AND their images. Ideally this should be one structure.
      // For simplicity and strictly parallel, we can execute the full related logic inside one promise wrapper.
      // But since we can't easily query related images without the related product IDs,
      // we'll keep the logic contained.

      const relatedLogic = async () => {
        const relatedProds = await db
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
          .where(
            and(
              eq(products.categoryId, product.categoryId!),
              eq(products.isActive, true),
              isNull(products.deletedAt),
              sql`${products.id} != ${product.id}`,
            ),
          )
          .limit(6)
          .all();

        if (relatedProds.length === 0) return [];

        const relatedProductIds = relatedProds.map((p) => p.id);
        const relatedProductImages = await db
          .select({
            productId: productImages.productId,
            url: productImages.url,
          })
          .from(productImages)
          .where(
            and(
              inArray(productImages.productId, relatedProductIds),
              eq(productImages.isPrimary, true),
            ),
          )
          .all();

        const relatedImageMap = new Map(
          relatedProductImages.map((img) => [img.productId, img.url]),
        );

        return relatedProds.map((relatedProduct) => ({
          ...relatedProduct,
          imageUrl: relatedImageMap.get(relatedProduct.id) || null,
          discountedPrice: calculateDiscountedPrice(
            relatedProduct.price,
            relatedProduct.discountType,
            relatedProduct.discountPercentage,
            relatedProduct.discountAmount,
          ),
        }));
      };

      promises.push(
        relatedLogic().then((res) => ({ type: "relatedProducts", data: res })),
      );
    }

    // 6. Attributes Promise
    promises.push(
      db
        .select({
          name: productAttributes.name,
          value: productAttributeValues.value,
          slug: productAttributes.slug,
        })
        .from(productAttributeValues)
        .innerJoin(
          productAttributes,
          and(
            eq(productAttributeValues.attributeId, productAttributes.id),
            isNull(productAttributes.deletedAt),
            eq(productAttributes.filterable, true),
          ),
        )
        .where(eq(productAttributeValues.productId, product.id))
        .then((res) => ({ type: "attributes", data: res })),
    );

    // --- EXECUTE ALL ---
    const results = await Promise.all(promises);

    // --- EXTRACT RESULTS ---
    const images =
      (results.find((r) => r.type === "images")?.data as any[]) || [];
    const variants =
      (results.find((r) => r.type === "variants")?.data as any[]) || [];
    const category =
      (results.find((r) => r.type === "category")?.data as any) || null;
    const additionalInfo =
      (results.find((r) => r.type === "additionalInfo")?.data as any[]) || [];
    const formattedRelatedProducts =
      (results.find((r) => r.type === "relatedProducts")?.data as any[]) || [];
    const assignedAttributes =
      (results.find((r) => r.type === "attributes")?.data as any[]) || [];

    const hasVariants = variants.length > 0;

    const formattedVariants =
      variants.length > 0
        ? variants.map((variant) => ({
            ...variant,
            createdAt: unixToDate(variant.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(variant.updatedAt)?.toISOString() || null,
            deletedAt: variant.deletedAt
              ? unixToDate(variant.deletedAt)?.toISOString()
              : null,
          }))
        : [
            {
              id: "default",
              productId: product.id,
              size: null,
              color: null,
              weight: null,
              sku: `SKU-${product.id}`,
              price: product.price,
              stock: 100,
              discountType: "percentage",
              discountPercentage: 0,
              discountAmount: 0,
              createdAt: unixToDate(product.createdAt)?.toISOString() || null,
              updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
              deletedAt: null,
            },
          ];

    const features = extractFeatures(product.description);

    return c.json({
      product: {
        ...product,
        hasVariants,
        createdAt: unixToDate(product.createdAt)?.toISOString() || null,
        updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        deletedAt: product.deletedAt
          ? unixToDate(product.deletedAt)?.toISOString()
          : null,
        discountType: product.discountType || "percentage",
        discountPercentage: product.discountPercentage || 0,
        discountAmount: product.discountAmount || 0,
        freeDelivery: product.freeDelivery || false,
        features,
        discountedPrice: calculateDiscountedPrice(
          product.price,
          product.discountType,
          product.discountPercentage,
          product.discountAmount,
        ),
        attributes: assignedAttributes,
        additionalInfo: additionalInfo,
      },
      category,
      images: images.map((img) => ({
        ...img,
        createdAt: unixToDate(img.createdAt)?.toISOString() || null,
        alt: img.alt || product.name,
      })),
      variants: formattedVariants,
      relatedProducts: formattedRelatedProducts,
    });
  } catch (error) {
    console.error("Error fetching product:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch product";
    const errorStack =
      error instanceof Error && process.env.NODE_ENV === "development"
        ? error.stack
        : undefined;

    return c.json(
      {
        error: errorMessage,
        stack: errorStack,
        slug: c.req.param("slug"),
      },
      500,
    );
  }
});

app.get("/:productId/variants", async (c) => {
  try {
    const productId = c.req.param("productId");
    const variants = await db
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
        createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, productId),
          isNull(productVariants.deletedAt),
        ),
      )
      .orderBy(
        productVariants.colorSortOrder,
        productVariants.sizeSortOrder,
        productVariants.createdAt,
      )
      .all();

    const formattedVariants = variants.map((variant) => ({
      ...variant,
      createdAt: unixToDate(variant.createdAt)?.toISOString() || null,
      updatedAt: unixToDate(variant.updatedAt)?.toISOString() || null,
    }));

    return c.json({ variants: formattedVariants });
  } catch (error) {
    console.error("Error fetching product variants:", error);
    return c.json({ error: "Failed to fetch product variants" }, 500);
  }
});

app.get("/category/:categorySlug", async (c) => {
  try {
    const categorySlug = c.req.param("categorySlug");
    const params = productFilterSchema.parse(c.req.query());
    const {
      page,
      limit,
      sort,
      search,
      minPrice,
      maxPrice,
      freeDelivery,
      hasDiscount,
    } = params;

    const category = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        description: categories.description,
        imageUrl: categories.imageUrl,
        metaTitle: categories.metaTitle,
        metaDescription: categories.metaDescription,
      })
      .from(categories)
      .where(
        and(eq(categories.slug, categorySlug), isNull(categories.deletedAt)),
      )
      .get();

    if (!category) {
      return c.json({ error: "Category not found" }, 404);
    }

    const conditions = [
      eq(products.isActive, true),
      isNull(products.deletedAt),
      eq(products.categoryId, category.id),
    ];

    if (search) {
      conditions.push(like(products.name, `%${search}%`));
    }
    if (minPrice !== undefined) {
      conditions.push(sql`${products.price} >= ${minPrice}`);
    }
    if (maxPrice !== undefined) {
      conditions.push(sql`${products.price} <= ${maxPrice}`);
    }
    if (freeDelivery === "true") {
      conditions.push(eq(products.freeDelivery, true));
    } else if (freeDelivery === "false") {
      conditions.push(eq(products.freeDelivery, false));
    }
    if (hasDiscount === "true") {
      conditions.push(sql`${products.discountPercentage} > 0`);
    } else if (hasDiscount === "false") {
      conditions.push(
        sql`${products.discountPercentage} = 0 OR ${products.discountPercentage} IS NULL`,
      );
    }

    let orderBy;
    if (sort === "price-asc") {
      orderBy = sql`CASE 
        WHEN ${products.discountPercentage} > 0 
        THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100))
        ELSE ${products.price}
      END`;
    } else if (sort === "price-desc") {
      orderBy = desc(sql`CASE 
        WHEN ${products.discountPercentage} > 0 
        THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100))
        ELSE ${products.price}
      END`);
    } else if (sort === "name-asc") {
      orderBy = products.name;
    } else if (sort === "name-desc") {
      orderBy = desc(products.name);
    } else if (sort === "discount") {
      orderBy = desc(products.discountPercentage);
    } else {
      orderBy = desc(products.createdAt);
    }

    const offset = (page - 1) * limit;

    const productsList = await db
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
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset)
      .all();

    const productIds = productsList.map((p) => p.id);
    const images = await db
      .select({
        productId: productImages.productId,
        url: productImages.url,
      })
      .from(productImages)
      .where(
        and(
          eq(productImages.isPrimary, true),
          inArray(productImages.productId, productIds),
        ),
      )
      .all();

    const imageMap = new Map(images.map((img) => [img.productId, img.url]));

    const productsWithImages = productsList.map((product) => ({
      ...product,
      imageUrl: imageMap.get(product.id) || null,
      discountedPrice: calculateDiscountedPrice(
        product.price,
        product.discountType,
        product.discountPercentage,
        product.discountAmount,
      ),
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        imageUrl: category.imageUrl,
        metaTitle: category.metaTitle,
        metaDescription: category.metaDescription,
      },
    }));

    const totalCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(and(...conditions))
      .get();

    return c.json({
      products: productsWithImages,
      pagination: {
        page,
        limit,
        total: totalCount?.count || 0,
        totalPages: Math.ceil((totalCount?.count || 0) / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching products by category:", error);
    return c.json({ error: "Failed to fetch products by category" }, 500);
  }
});

app.get("/search", async (c) => {
  try {
    const queryParams = c.req.query();
    const validation = productSearchSchema.safeParse(queryParams);

    if (!validation.success) {
      return c.json(
        {
          success: false,
          error: "Invalid query parameters",
          details: validation.error.errors,
        },
        400,
      );
    }

    const { search, page, limit } = validation.data;
    const offset = (page - 1) * limit;

    const whereConditions = [
      isNull(products.deletedAt),
      eq(products.isActive, true),
    ];

    if (search) {
      whereConditions.push(like(products.name, `%${search}%`));
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(and(...whereConditions));

    const results = await db
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        discountType: products.discountType,
        discountPercentage: products.discountPercentage,
        discountAmount: products.discountAmount,
        primaryImageUrl: sql<string>`(
          SELECT ${productImages.url}
          FROM ${productImages}
          WHERE ${productImages.productId} = ${products.id}
          AND ${productImages.isPrimary} = 1
          LIMIT 1
        )`.as("primaryImageUrl"),
      })
      .from(products)
      .where(and(...whereConditions))
      .orderBy(desc(products.updatedAt))
      .limit(limit)
      .offset(offset);

    const productIds = results.map((p) => p.id);
    const variants =
      productIds.length > 0
        ? await db
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
            .where(
              and(
                inArray(productVariants.productId, productIds),
                isNull(productVariants.deletedAt),
              ),
            )
            .orderBy(
              productVariants.colorSortOrder,
              productVariants.sizeSortOrder,
              productVariants.createdAt,
            )
        : [];

    const productsWithVariants = results.map((product) => ({
      ...product,
      variants: variants.filter((v) => v.productId === product.id),
    }));

    const totalPages = Math.ceil(count / limit);
    const pagination = {
      page,
      limit,
      total: count,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return c.json({ success: true, data: productsWithVariants, pagination });
  } catch (error) {
    console.error("Error searching products:", error);
    return c.json({ success: false, error: "Failed to search products" }, 500);
  }
});

export { app as productRoutes };
