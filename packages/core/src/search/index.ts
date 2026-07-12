import type { Database } from "@scalius/database/client";
import { products, productImages, categories, pages } from "@scalius/database/schema";
import { eq, sql, and, inArray, type SQL } from "drizzle-orm";
import { ftsMatch, sanitizeFtsQuery } from "./fts5";
import { publicProductBaseConditions } from "../modules/products/products.public-eligibility";
import {
  buildBuyerCatalogPricingProjection,
  buyerCatalogHasSkuInPriceRange,
} from "../modules/products/products.buyer-projection";
import { publicCategoryConditions } from "../modules/categories/categories.publication";
export { ftsMatch, sanitizeFtsQuery } from "./fts5";

// Types for search results
export type ProductSearchResult = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  discountedPrice: number;
  priceVaries: boolean;
  availableForSale: boolean;
  hasVariants: boolean;
  slug: string;
  imageUrl?: string | null;
  categoryId: string | null;
  categoryName?: string | null;
  type: "product";
};

export type PageSearchResult = {
  id: string;
  title: string;
  slug: string;
  content: string;
  type: "page";
};

export type CategorySearchResult = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
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
  if (hasValidQuery && !sanitizeFtsQuery(query)) {
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
        id: products.id,
        name: products.name,
        description: products.description,
        price: buyerPricing.basePrice,
        discountedPrice: buyerPricing.effectivePrice,
        maxBuyerPrice: buyerPricing.maxBuyerPrice,
        availableForSale: buyerPricing.availableForSale,
        hasVariants: buyerPricing.hasCustomerOptions,
        slug: products.slug,
        categoryId: categories.id,
        categoryName: sql<string>`${categories.name}`.as("categoryName"),
      })
      .from(products)
      .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
      .leftJoin(categories, and(
        eq(products.categoryId, categories.id),
        ...publicCategoryConditions(),
      ))
      .where(and(...productConditions))
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
          content: pages.content,
        })
        .from(pages)
        .where(and(...pageConditions))
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
          description: categories.description,
        })
        .from(categories)
        .where(and(...categoryConditions))
        .limit(limit)
      : db.select({ id: sql`NULL` }).from(categories).where(sql`1 = 0`); // Dummy query

    // Execute searches in a single Turso batch
    const [productsResult, pagesResult, categoriesResult] = await db.batch([
      productQuery,
      pageQuery,
      categoryQuery,
    ]);

    // N+1 fix for images: we fetch them after just for the returned rows
    let formattedProducts: ProductSearchResult[] = [];
    if (productsResult.length > 0) {
      const productIds = productsResult.map(p => p.id);
      const primaryImages = await db
        .select({
          productId: productImages.productId,
          url: productImages.url,
        })
        .from(productImages)
        .where(
          and(
            inArray(productImages.productId, productIds),
            eq(productImages.isPrimary, true),
          ),
        );

      const imageUrlMap = new Map<string, string>();
      for (const img of primaryImages) {
        if (img.productId && img.url) {
          imageUrlMap.set(img.productId, img.url);
        }
      }

      formattedProducts = productsResult.map(({
        maxBuyerPrice,
        availableForSale,
        hasVariants,
        ...product
      }) => ({
        ...product,
        availableForSale: Boolean(availableForSale),
        hasVariants: Boolean(hasVariants),
        priceVaries: maxBuyerPrice > product.discountedPrice,
        imageUrl: imageUrlMap.get(product.id) || null,
        type: "product" as const,
      }));
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
