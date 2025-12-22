// src/server/routes/attributes.ts
import { Hono } from "hono";

import {
  productAttributes,
  productAttributeValues,
  products,
  categories,
} from "@/db/schema";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

const app = new Hono<{ Bindings: Env }>();

// Cache this endpoint as it changes infrequently
app.use(
  "/filterable",
  cacheMiddleware({
    ttl: 3600, // 1 hour
    keyPrefix: "api:attributes:filterable",
  }),
);

// Cache category-specific attributes
app.use(
  "/category/:categoryId",
  cacheMiddleware({
    ttl: 1800, // 30 minutes
    keyPrefix: "api:attributes:category",
    varyByQuery: false,
  }),
);

// Cache category-specific attributes by slug
app.use(
  "/category-slug/:categorySlug",
  cacheMiddleware({
    ttl: 1800, // 30 minutes
    keyPrefix: "api:attributes:category-slug",
    varyByQuery: false,
  }),
);

app.get("/filterable", async (c) => {
  try {
    const db = c.get("db");
    // 1. Get all attributes marked as filterable
    const filterableAttributes = await db
      .select({
        id: productAttributes.id,
        name: productAttributes.name,
        slug: productAttributes.slug,
      })
      .from(productAttributes)
      .where(
        and(
          eq(productAttributes.filterable, true),
          isNull(productAttributes.deletedAt),
        ),
      );

    if (filterableAttributes.length === 0) {
      return c.json({ filters: [] });
    }

    // 2. For each attribute, get all unique values assigned to products
    const attributeIds = filterableAttributes.map((attr) => attr.id);
    const uniqueValues =
      attributeIds.length > 0
        ? await db
            .selectDistinct({
              attributeId: productAttributeValues.attributeId,
              value: productAttributeValues.value,
            })
            .from(productAttributeValues)
            .where(inArray(productAttributeValues.attributeId, attributeIds))
        : [];

    // 3. Structure the data for the frontend
    const filters = filterableAttributes
      .map((attr) => ({
        id: attr.id,
        name: attr.name,
        slug: attr.slug,
        values: uniqueValues
          .filter((uv) => uv.attributeId === attr.id)
          .map((uv) => uv.value)
          .sort(),
      }))
      .filter((filter) => filter.values.length > 0); // Only return filters that have values

    return c.json({ filters });
  } catch (error) {
    console.error("Error fetching filterable attributes:", error);
    return c.json({ error: "Failed to fetch filters" }, 500);
  }
});

// Get attributes and values for a specific category by ID
app.get("/category/:categoryId", async (c) => {
  try {
    const db = c.get("db");
    const categoryId = c.req.param("categoryId");

    // 1. Get all filterable attributes that have values in products of this category
    const categoryAttributes = await db
      .selectDistinct({
        attributeId: productAttributeValues.attributeId,
        attributeName: productAttributes.name,
        attributeSlug: productAttributes.slug,
        value: productAttributeValues.value,
      })
      .from(productAttributeValues)
      .innerJoin(
        productAttributes,
        and(
          eq(productAttributeValues.attributeId, productAttributes.id),
          eq(productAttributes.filterable, true),
          isNull(productAttributes.deletedAt),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(productAttributeValues.productId, products.id),
          eq(products.categoryId, categoryId),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      );

    // 2. Group by attribute and collect values
    const attributeMap = new Map();
    categoryAttributes.forEach((item) => {
      if (!attributeMap.has(item.attributeId)) {
        attributeMap.set(item.attributeId, {
          id: item.attributeId,
          name: item.attributeName,
          slug: item.attributeSlug,
          values: new Set(),
        });
      }
      attributeMap.get(item.attributeId).values.add(item.value);
    });

    // 3. Convert to final format
    const filters = Array.from(attributeMap.values()).map((attr) => ({
      id: attr.id,
      name: attr.name,
      slug: attr.slug,
      values: Array.from(attr.values).sort(),
    }));

    return c.json({ filters });
  } catch (error) {
    console.error("Error fetching category attributes:", error);
    return c.json({ error: "Failed to fetch category filters" }, 500);
  }
});

// Get attributes and values for a specific category by slug
app.get("/category-slug/:categorySlug", async (c) => {
  try {
    const db = c.get("db");
    const categorySlug = c.req.param("categorySlug");

    // 1. First get the category ID from slug
    const category = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.slug, categorySlug), isNull(categories.deletedAt)),
      )
      .get();

    if (!category) {
      return c.json({ error: "Category not found" }, 404);
    }

    // 2. Get all filterable attributes that have values in products of this category
    const categoryAttributes = await db
      .selectDistinct({
        attributeId: productAttributeValues.attributeId,
        attributeName: productAttributes.name,
        attributeSlug: productAttributes.slug,
        value: productAttributeValues.value,
      })
      .from(productAttributeValues)
      .innerJoin(
        productAttributes,
        and(
          eq(productAttributeValues.attributeId, productAttributes.id),
          eq(productAttributes.filterable, true),
          isNull(productAttributes.deletedAt),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(productAttributeValues.productId, products.id),
          eq(products.categoryId, category.id),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      );

    // 3. Group by attribute and collect values
    const attributeMap = new Map();
    categoryAttributes.forEach((item) => {
      if (!attributeMap.has(item.attributeId)) {
        attributeMap.set(item.attributeId, {
          id: item.attributeId,
          name: item.attributeName,
          slug: item.attributeSlug,
          values: new Set(),
        });
      }
      attributeMap.get(item.attributeId).values.add(item.value);
    });

    // 4. Convert to final format
    const filters = Array.from(attributeMap.values()).map((attr) => ({
      id: attr.id,
      name: attr.name,
      slug: attr.slug,
      values: Array.from(attr.values).sort(),
    }));

    return c.json({ filters });
  } catch (error) {
    console.error("Error fetching category attributes by slug:", error);
    return c.json({ error: "Failed to fetch category filters" }, 500);
  }
});

// Get attributes and values for search results
app.get("/search-filters", async (c) => {
  try {
    const db = c.get("db");
    const query = c.req.query("q");
    const categoryId = c.req.query("categoryId"); // Optional: if you want to limit to a specific category

    if (!query || query.trim().length === 0) {
      return c.json({ filters: [] });
    }

    let searchConditions = [
      eq(products.isActive, true),
      isNull(products.deletedAt),
      sql`${products.name} LIKE ${`%${query.trim()}%`}`,
    ];

    // If categoryId is provided, add it to conditions
    if (categoryId) {
      searchConditions.push(eq(products.categoryId, categoryId));
    }

    // 1. Find products that match the search query
    const matchingProducts = await db
      .select({ id: products.id, categoryId: products.categoryId })
      .from(products)
      .where(and(...searchConditions))
      .limit(100); // Limit to prevent excessive queries

    if (matchingProducts.length === 0) {
      return c.json({ filters: [] });
    }

    // 2. Get all categories from matching products
    const categoryIds = [...new Set(matchingProducts.map((p) => p.categoryId))];

    // 3. Get all filterable attributes that have values in products of these categories
    const searchAttributes = await db
      .selectDistinct({
        attributeId: productAttributeValues.attributeId,
        attributeName: productAttributes.name,
        attributeSlug: productAttributes.slug,
        value: productAttributeValues.value,
      })
      .from(productAttributeValues)
      .innerJoin(
        productAttributes,
        and(
          eq(productAttributeValues.attributeId, productAttributes.id),
          eq(productAttributes.filterable, true),
          isNull(productAttributes.deletedAt),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(productAttributeValues.productId, products.id),
          inArray(products.categoryId, categoryIds),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      );

    // 4. Group by attribute and collect values
    const attributeMap = new Map();
    searchAttributes.forEach((item) => {
      if (!attributeMap.has(item.attributeId)) {
        attributeMap.set(item.attributeId, {
          id: item.attributeId,
          name: item.attributeName,
          slug: item.attributeSlug,
          values: new Set(),
        });
      }
      attributeMap.get(item.attributeId).values.add(item.value);
    });

    // 5. Convert to final format
    const filters = Array.from(attributeMap.values()).map((attr) => ({
      id: attr.id,
      name: attr.name,
      slug: attr.slug,
      values: Array.from(attr.values).sort(),
    }));

    return c.json({ filters });
  } catch (error) {
    console.error("Error fetching search filters:", error);
    return c.json({ error: "Failed to fetch search filters" }, 500);
  }
});

export { app as attributeRoutes };
