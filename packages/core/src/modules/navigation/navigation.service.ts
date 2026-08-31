// Bounded admin picker and preview reads for the navigation authority.

import { and, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { categories, collections, pages, products } from "@scalius/database/schema";
import { NotFoundError } from "@scalius/core/errors";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { getPublicCategoryById } from "../categories/categories.storefront";
import { publicCategoryConditions } from "../categories/categories.publication";
import { getStorefrontProducts } from "../products/products.storefront";

export interface NavigationPreviewProductCountInput {
  categoryId: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  freeDelivery?: "true" | "false";
  hasDiscount?: "true" | "false";
  attributeFilters?: { slug: string; value: string }[];
}

/** Legacy bounded picker retained for its published admin operation. */
export async function getNavigationItems(db: Database) {
  const categoriesData = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      canonicalPath: categories.canonicalPath,
      type: sql<string>`'category'`.as("type"),
    })
    .from(categories)
    .where(and(...publicCategoryConditions()))
    .orderBy(categories.name)
    .limit(100);

  const pagesData = await db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      type: sql<string>`'page'`.as("type"),
    })
    .from(pages)
    .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
    .orderBy(pages.title)
    .limit(100);

  const productsData = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      canonicalPath: products.canonicalPath,
    })
    .from(products)
    .where(sql`${products.deletedAt} IS NULL AND ${products.isActive} = true`)
    .orderBy(products.name)
    .limit(100);

  const collectionsData = await db
    .select({
      id: collections.id,
      name: collections.name,
      canonicalPath: collections.canonicalPath,
    })
    .from(collections)
    .where(sql`${collections.deletedAt} IS NULL AND ${collections.isActive} = true`)
    .orderBy(collections.name)
    .limit(100);

  return {
    categories: categoriesData.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      type: category.type,
      url: normalizeResourceCanonicalPath("category", category.canonicalPath)
        ?? `/categories/${category.slug}`,
    })),
    pages: pagesData.map((page) => ({
      id: page.id,
      name: page.title,
      slug: page.slug,
      type: page.type,
      url: `/${page.slug}`,
    })),
    products: productsData.map((product) => ({
      id: product.id,
      name: product.name,
      slug: product.slug,
      type: "product",
      url: normalizeResourceCanonicalPath("product", product.canonicalPath)
        ?? `/products/${product.slug}`,
    })),
    collections: collectionsData.map((collection) => ({
      id: collection.id,
      name: collection.name,
      slug: collection.id,
      type: "collection",
      url: normalizeResourceCanonicalPath("collection", collection.canonicalPath)
        ?? `/collections/${collection.id}`,
    })),
  };
}

export async function getNavigationPreviewProductCount(
  db: Database,
  input: NavigationPreviewProductCountInput,
) {
  const category = await getPublicCategoryById(db, input.categoryId);
  if (!category) throw new NotFoundError("Category not found");

  const result = await getStorefrontProducts(db, {
    category: input.categoryId,
    search: input.search,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    freeDelivery: input.freeDelivery,
    hasDiscount: input.hasDiscount,
    page: 1,
    limit: 1,
    sort: "newest",
    attributeFilters: (input.attributeFilters ?? []).map((filter) => ({
      id: filter.slug,
      name: filter.slug,
      slug: filter.slug,
      values: [filter.value],
    })),
  });

  return { count: result.pagination.total };
}
