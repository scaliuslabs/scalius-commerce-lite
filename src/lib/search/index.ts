import { db } from "@/db";
import { products, productImages, categories, pages } from "@/db/schema";
import { eq, sql, and, inArray, or, like, gte, lte } from "drizzle-orm";

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

/**
 * Fetch all products with their primary images and category names
 * Used for search and indexing
 */
async function fetchProducts(
  searchQuery?: string,
  options?: {
    limit?: number;
    categoryId?: string;
    minPrice?: number;
    maxPrice?: number;
  },
): Promise<ProductSearchResult[]> {
  try {
    // Build conditions for product search
    const conditions = [];
    conditions.push(
      sql`${products.deletedAt} IS NULL AND ${products.isActive} = 1`,
    );

    if (searchQuery && searchQuery.trim() !== "") {
      // Search in name and description
      conditions.push(
        or(
          like(products.name, `%${searchQuery}%`),
          like(products.description, `%${searchQuery}%`),
        ),
      );
    }

    if (options?.categoryId) {
      conditions.push(eq(products.categoryId, options.categoryId));
    }

    if (typeof options?.minPrice === "number") {
      conditions.push(gte(products.price, options.minPrice));
    }

    if (typeof options?.maxPrice === "number") {
      conditions.push(lte(products.price, options.maxPrice));
    }

    // Query the database for products with their categories
    const productsData = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        slug: products.slug,
        categoryId: products.categoryId,
        categoryName: categories.name,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(and(...conditions))
      .limit(options?.limit || 100);

    // Get all product IDs from the query result
    const productIds = productsData.map((product) => product.id);

    // Ensure we have at least one product ID to avoid empty query errors
    if (productIds.length === 0) {
      return [];
    }

    console.log(`Found ${productIds.length} products, fetching images...`);

    // Fetch primary images in a separate query
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

    // Create a map of product ID to image URL for quick lookup
    const imageUrlMap = new Map<string, string>();
    for (const img of primaryImages) {
      if (img.productId && img.url) {
        imageUrlMap.set(img.productId, img.url);
      }
    }

    // Add image URLs to the product data
    const productsWithImages = productsData.map((product) => ({
      ...product,
      imageUrl: imageUrlMap.get(product.id) || null,
      type: "product" as const,
    }));

    return productsWithImages;
  } catch (error) {
    console.error("Error fetching products with images:", error);
    throw error;
  }
}

/**
 * Fetch all published pages
 * Used for search and indexing
 */
async function fetchPages(
  searchQuery?: string,
  limit?: number,
): Promise<PageSearchResult[]> {
  const conditions = [];
  conditions.push(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = 1`);

  if (searchQuery && searchQuery.trim() !== "") {
    // Search in title and content
    conditions.push(
      or(
        like(pages.title, `%${searchQuery}%`),
        like(pages.content, `%${searchQuery}%`),
      ),
    );
  }

  const allPages = await db
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      content: pages.content,
    })
    .from(pages)
    .where(and(...conditions))
    .limit(limit || 100);

  return allPages.map((page) => ({
    ...page,
    type: "page" as const,
  }));
}

/**
 * Fetch all categories
 * Used for search and indexing
 */
async function fetchCategories(
  searchQuery?: string,
  limit?: number,
): Promise<CategorySearchResult[]> {
  const conditions = [];
  conditions.push(sql`${categories.deletedAt} IS NULL`);

  if (searchQuery && searchQuery.trim() !== "") {
    // Search in name and description
    conditions.push(
      or(
        like(categories.name, `%${searchQuery}%`),
        like(categories.description, `%${searchQuery}%`),
      ),
    );
  }

  const allCategories = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
    })
    .from(categories)
    .where(and(...conditions))
    .limit(limit || 100);

  return allCategories.map((category) => ({
    ...category,
    type: "category" as const,
  }));
}

/**
 * Search function that queries the database directly
 * This replaces the MeiliSearch implementation with a direct database search
 */
export async function search(
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
  console.log(`Search request: "${query}" with options:`, options);

  const limit = options?.limit || 10;
  const searchPages = options?.searchPages !== false;
  const searchCategories = options?.searchCategories !== false;

  try {
    // Execute searches in parallel
    const searchPromises: [
      Promise<ProductSearchResult[]>,
      Promise<PageSearchResult[]> | Promise<[]>,
      Promise<CategorySearchResult[]> | Promise<[]>,
    ] = [
        fetchProducts(query, {
          limit,
          categoryId: options?.categoryId,
          minPrice: options?.minPrice,
          maxPrice: options?.maxPrice,
        }),
        searchPages ? fetchPages(query, limit) : Promise.resolve([]),
        searchCategories ? fetchCategories(query, limit) : Promise.resolve([]),
      ];

    const [products, pages, categories] = await Promise.all(searchPromises);

    console.log(
      `Search for "${query}" found products: ${products.length}, pages: ${pages.length}, categories: ${categories.length}`,
    );

    return {
      products,
      pages,
      categories,
    };
  } catch (error) {
    console.error("Search error:", error);
    // Return empty results in case of error
    return {
      products: [],
      pages: [],
      categories: [],
    };
  }
}
