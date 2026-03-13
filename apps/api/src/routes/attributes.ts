// src/server/routes/attributes.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  productAttributes,
  productAttributeValues,
  products,
  categories
} from "@scalius/database/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { ftsMatch } from "@scalius/core/search";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Cache this endpoint as it changes infrequently
app.use(
  "/filterable",
  cacheMiddleware({
    ttl: 3600, // 1 hour
    keyPrefix: "api:attributes:filterable"
  }),
);

// Cache category-specific attributes
app.use(
  "/category/:categoryId",
  cacheMiddleware({
    ttl: 1800, // 30 minutes
    keyPrefix: "api:attributes:category",
    varyByQuery: false
  }),
);

// Cache category-specific attributes by slug
app.use(
  "/category-slug/:categorySlug",
  cacheMiddleware({
    ttl: 1800, // 30 minutes
    keyPrefix: "api:attributes:category-slug",
    varyByQuery: false
  }),
);

// GET /attributes/filterable
const filterableRoute = createRoute({
  method: "get",
  path: "/filterable",
  tags: ["Attributes"],
  summary: "Get all filterable product attributes with values",
  responses: {
    200: {
      description: "Filterable attributes list"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(filterableRoute, async (c) => {
  const db = c.get("db");
  // 1. Get all attributes marked as filterable
  const filterableAttributes = await db
    .select({
      id: productAttributes.id,
      name: productAttributes.name,
      slug: productAttributes.slug
    })
    .from(productAttributes)
    .where(
      and(
        eq(productAttributes.filterable, true),
        isNull(productAttributes.deletedAt),
      ),
    );

  if (filterableAttributes.length === 0) {
    return c.json({ filters: [] }, 200);
  }

  // 2. For each attribute, get all unique values assigned to products
  const attributeIds = filterableAttributes.map((attr) => attr.id);
  const uniqueValues =
    attributeIds.length > 0
      ? await db
          .selectDistinct({
            attributeId: productAttributeValues.attributeId,
            value: productAttributeValues.value
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
        .sort()
    }))
    .filter((filter) => filter.values.length > 0);

  return c.json({ filters }, 200);
});

// GET /attributes/category/:categoryId
const categoryAttributesRoute = createRoute({
  method: "get",
  path: "/category/{categoryId}",
  tags: ["Attributes"],
  summary: "Get filterable attributes for a category by ID",
  responses: {
    200: {
      description: "Category-specific filterable attributes"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(categoryAttributesRoute, async (c) => {
  const db = c.get("db");
  const { categoryId } = c.req.valid("param");

  // 1. Get all filterable attributes that have values in products of this category
  const categoryAttributes = await db
    .selectDistinct({
      attributeId: productAttributeValues.attributeId,
      attributeName: productAttributes.name,
      attributeSlug: productAttributes.slug,
      value: productAttributeValues.value
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
        values: new Set()
      });
    }
    attributeMap.get(item.attributeId).values.add(item.value);
  });

  // 3. Convert to final format
  const filters = Array.from(attributeMap.values()).map((attr) => ({
    id: attr.id,
    name: attr.name,
    slug: attr.slug,
    values: Array.from(attr.values).sort()
  }));

  return c.json({ filters }, 200);
});

// GET /attributes/category-slug/:categorySlug
const categorySlugAttributesRoute = createRoute({
  method: "get",
  path: "/category-slug/{categorySlug}",
  tags: ["Attributes"],
  summary: "Get filterable attributes for a category by slug",
  responses: {
    200: {
      description: "Category-specific filterable attributes"
    },
    404: {
      description: "Category not found"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(categorySlugAttributesRoute, async (c) => {
  const db = c.get("db");
  const { categorySlug } = c.req.valid("param");

  // 1. First get the category ID from slug
  const category = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(eq(categories.slug, categorySlug), isNull(categories.deletedAt)),
    )
    .get();

  if (!category) {
    throw new NotFoundError("Category not found");
  }

  // 2. Get all filterable attributes that have values in products of this category
  const categoryAttributes = await db
    .selectDistinct({
      attributeId: productAttributeValues.attributeId,
      attributeName: productAttributes.name,
      attributeSlug: productAttributes.slug,
      value: productAttributeValues.value
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
        values: new Set()
      });
    }
    attributeMap.get(item.attributeId).values.add(item.value);
  });

  // 4. Convert to final format
  const filters = Array.from(attributeMap.values()).map((attr) => ({
    id: attr.id,
    name: attr.name,
    slug: attr.slug,
    values: Array.from(attr.values).sort()
  }));

  return c.json({ filters }, 200);
});

// GET /attributes/search-filters
const searchFiltersRoute = createRoute({
  method: "get",
  path: "/search-filters",
  tags: ["Attributes"],
  summary: "Get filterable attributes for search results",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "Search query" }),
      categoryId: z.string().optional().openapi({ description: "Optional category filter" })
    })
  },
  responses: {
    200: {
      description: "Search-specific filterable attributes"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(searchFiltersRoute, async (c) => {
  const db = c.get("db");
  const { q: query, categoryId } = c.req.valid("query");

  if (!query || query.trim().length === 0) {
    return c.json({ filters: [] }, 200);
  }

  let searchConditions = [
    eq(products.isActive, true),
    isNull(products.deletedAt),
  ];

  const ftsCond = ftsMatch("products_fts", "products", query.trim());
  if (ftsCond) searchConditions.push(ftsCond);

  // If categoryId is provided, add it to conditions
  if (categoryId) {
    searchConditions.push(eq(products.categoryId, categoryId));
  }

  // 1. Find products that match the search query
  const matchingProducts = await db
    .select({ id: products.id, categoryId: products.categoryId })
    .from(products)
    .where(and(...searchConditions))
    .limit(100);

  if (matchingProducts.length === 0) {
    return c.json({ filters: [] }, 200);
  }

  // 2. Get all categories from matching products
  const categoryIds = [...new Set(matchingProducts.map((p) => p.categoryId))];

  // 3. Get all filterable attributes that have values in products of these categories
  const searchAttributes = await db
    .selectDistinct({
      attributeId: productAttributeValues.attributeId,
      attributeName: productAttributes.name,
      attributeSlug: productAttributes.slug,
      value: productAttributeValues.value
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
        values: new Set()
      });
    }
    attributeMap.get(item.attributeId).values.add(item.value);
  });

  // 5. Convert to final format
  const filters = Array.from(attributeMap.values()).map((attr) => ({
    id: attr.id,
    name: attr.name,
    slug: attr.slug,
    values: Array.from(attr.values).sort()
  }));

  return c.json({ filters }, 200);
});

export { app as attributeRoutes };
