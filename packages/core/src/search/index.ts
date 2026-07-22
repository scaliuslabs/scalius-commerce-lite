import type { Database } from "@scalius/database/client";
import { products, categories, pages } from "@scalius/database/schema";
import { eq, sql, and, type SQL } from "drizzle-orm";
import { ftsMatch, sanitizeFtsQuery } from "./fts5";
import { publicProductBaseConditions } from "../modules/products/products.public-eligibility";
import {
  buildBuyerCatalogPricingProjection,
  buyerCatalogHasSkuInPriceRange,
} from "../modules/products/products.buyer-projection";
import { publicCategoryConditions } from "../modules/categories/categories.publication";
import {
  loadProductMediaProjections,
  resolveProductImageRepresentation,
} from "../modules/products/products.media";
export { ftsMatch, sanitizeFtsQuery } from "./fts5";

// Types for search results
export type ProductSearchResult = {
  id: string;
  name: string;
  price: number;
  discountedPrice: number;
  priceVaries: boolean;
  availableForSale: boolean;
  hasVariants: boolean;
  slug: string;
  imageUrl: string | null;
  imageMediaId: string | null;
  imageAlt: string | null;
  categoryId: string | null;
  categoryName: string | null;
  type: "product";
};

export type PageSearchResult = {
  id: string;
  title: string;
  slug: string;
  type: "page";
};

export type CategorySearchResult = {
  id: string;
  name: string;
  slug: string;
  type: "category";
};

export type SearchResult =
  | ProductSearchResult
  | PageSearchResult
  | CategorySearchResult;

export async function search(
  db: Database,
  query: string,
  options?: {
    limit?: number;
    categoryId?: string;
    minPrice?: number;
    maxPrice?: number;
    searchPages?: boolean;
    searchCategories?: boolean;
  },
): Promise<{
  products: ProductSearchResult[];
  pages: PageSearchResult[];
  categories: CategorySearchResult[];
}> {
  const limit = options?.limit || 10;
  const searchPages = options?.searchPages !== false;
  const searchCategories = options?.searchCategories !== false;
  const hasValidQuery = query && query.trim() !== "";
  const sanitizedQuery = hasValidQuery ? sanitizeFtsQuery(query) : "";
  if (hasValidQuery && !sanitizedQuery) {
    return { products: [], pages: [], categories: [] };
  }

  try {
    // Build Product Query
    const productConditions: SQL[] = publicProductBaseConditions();
    if (hasValidQuery) {
      const cond = ftsMatch("products_fts", "products", query);
      if (cond) productConditions.push(cond);
    }
    if (options?.categoryId) {
      productConditions.push(
        eq(products.categoryId, options.categoryId),
        sql`EXISTS (
          SELECT 1 FROM ${categories}
          WHERE ${categories.id} = ${options.categoryId}
            AND ${and(...publicCategoryConditions())}
        )`,
      );
    }
    if (
      typeof options?.minPrice === "number" ||
      typeof options?.maxPrice === "number"
    ) {
      productConditions.push(
        buyerCatalogHasSkuInPriceRange(options?.minPrice, options?.maxPrice),
      );
    }
    const buyerPricing = buildBuyerCatalogPricingProjection(db);

    const productQuery = db
      .select({
        // D1 batch rows are positionally decoded by Drizzle. Explicit aliases
        // are required for joined columns with the same database names; without
        // them, category.id can overwrite product.id and media enrichment then
        // looks up category IDs instead of products.
        id: sql<string>`${products.id}`.as("search_product_id"),
        name: sql<string>`${products.name}`.as("search_product_name"),
        price: buyerPricing.basePrice,
        discountedPrice: buyerPricing.effectivePrice,
        maxBuyerPrice: buyerPricing.maxBuyerPrice,
        availableForSale: buyerPricing.availableForSale,
        hasVariants: buyerPricing.hasCustomerOptions,
        slug: sql<string>`${products.slug}`.as("search_product_slug"),
        categoryId: sql<string | null>`${categories.id}`.as("search_category_id"),
        categoryName: sql<string | null>`${categories.name}`.as("search_category_name"),
      })
      .from(products)
      .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
      .leftJoin(categories, and(
        eq(products.categoryId, categories.id),
        ...publicCategoryConditions(),
      ))
      .where(and(...productConditions))
      .orderBy(
        hasValidQuery
          ? sql`COALESCE((SELECT rank FROM products_fts WHERE rowid = products.rowid AND products_fts MATCH ${sanitizedQuery}), 0) ASC`
          : products.name,
      )
      .limit(limit);

    // Build Pages Query
    const pageConditions = [sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = 1`];
    if (hasValidQuery) {
      const pageCond = ftsMatch("pages_fts", "pages", query);
      if (pageCond) pageConditions.push(pageCond);
    }
    const pageQuery = searchPages
      ? db
        .select({
          id: pages.id,
          title: pages.title,
          slug: pages.slug,
        })
        .from(pages)
        .where(and(...pageConditions))
        .orderBy(
          hasValidQuery
            ? sql`COALESCE((SELECT rank FROM pages_fts WHERE rowid = pages.rowid AND pages_fts MATCH ${sanitizedQuery}), 0) ASC`
            : pages.title,
        )
        .limit(limit)
      : db.select({ id: sql`NULL` }).from(pages).where(sql`1 = 0`); // Dummy query

    // Build Categories Query
    const categoryConditions = publicCategoryConditions();
    if (hasValidQuery) {
      const catCond = ftsMatch("categories_fts", "categories", query);
      if (catCond) categoryConditions.push(catCond);
    }
    const categoryQuery = searchCategories
      ? db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
        })
        .from(categories)
        .where(and(...categoryConditions))
        .orderBy(
          hasValidQuery
            ? sql`COALESCE((SELECT rank FROM categories_fts WHERE rowid = categories.rowid AND categories_fts MATCH ${sanitizedQuery}), 0) ASC`
            : categories.name,
        )
        .limit(limit)
      : db.select({ id: sql`NULL` }).from(categories).where(sql`1 = 0`); // Dummy query

    // Execute searches in a single Turso batch
    const [productsResult, pagesResult, categoriesResult] = await db.batch([
      productQuery,
      pageQuery,
      categoryQuery,
    ]);

    // Resolve one image representation in a bounded media join after the page query.
    let formattedProducts: ProductSearchResult[] = [];
    if (productsResult.length > 0) {
      const productIds = productsResult.map(p => p.id);
      const mediaMap = await loadProductMediaProjections(db, productIds);

      formattedProducts = productsResult.map(({
        maxBuyerPrice,
        availableForSale,
        hasVariants,
        ...product
      }) => {
        const image = resolveProductImageRepresentation(mediaMap.get(product.id) ?? []);
        return {
          ...product,
          availableForSale: Boolean(availableForSale),
          hasVariants: Boolean(hasVariants),
          priceVaries: maxBuyerPrice > product.discountedPrice,
          imageUrl: image?.url ?? null,
          imageMediaId: image?.mediaId ?? null,
          imageAlt: image?.altText ?? null,
          type: "product" as const,
        };
      });
    }

    // Format pages
    const formattedPages = (searchPages ? pagesResult : []).filter(
      (p) => p.id !== null
    ).map((page) => ({
      ...page,
      type: "page" as const,
    })) as PageSearchResult[];

    // Format categories
    const formattedCategories = (searchCategories ? categoriesResult : []).filter(
      (c) => c.id !== null
    ).map((category) => ({
      ...category,
      type: "category" as const,
    })) as CategorySearchResult[];

    return {
      products: formattedProducts,
      pages: formattedPages,
      categories: formattedCategories,
    };
  } catch (error: unknown) {
    console.error("Search error:", error);
    throw error;
  }
}
