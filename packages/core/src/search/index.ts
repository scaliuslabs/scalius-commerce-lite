import type { Database } from "@scalius/database/client";
import { products, productImages, categories, pages } from "@scalius/database/schema";
import { eq, sql, and, inArray, gte, lte } from "drizzle-orm";
import { ftsMatch } from "./fts5";
export { ftsMatch } from "./fts5";

// Types for search results
export type ProductSearchResult = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  slug: string;
  imageUrl?: string | null;
  categoryId: string;
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

  try {
    // Build Product Query
    const productConditions = [];
    productConditions.push(
      sql`${products.deletedAt} IS NULL AND ${products.isActive} = 1`,
    );
    if (hasValidQuery) {
      const cond = ftsMatch("products_fts", "products", query);
      if (cond) productConditions.push(cond);
    }
    if (options?.categoryId) {
      productConditions.push(eq(products.categoryId, options.categoryId));
    }
    if (typeof options?.minPrice === "number") {
      productConditions.push(gte(products.price, options.minPrice));
    }
    if (typeof options?.maxPrice === "number") {
      productConditions.push(lte(products.price, options.maxPrice));
    }

    const productQuery = db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        slug: products.slug,
        categoryId: products.categoryId,
        categoryName: sql<string>`${categories.name}`.as("categoryName"),
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
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
    const categoryConditions = [sql`${categories.deletedAt} IS NULL`];
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

      formattedProducts = productsResult.map((product) => ({
        ...product,
        imageUrl: imageUrlMap.get(product.id) || null,
        type: "product" as const,
      })) as ProductSearchResult[];
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
    // Return empty results in case of error
    return {
      products: [],
      pages: [],
      categories: [],
    };
  }
}
