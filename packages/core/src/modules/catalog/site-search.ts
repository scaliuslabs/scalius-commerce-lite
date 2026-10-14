import {
    applyTranslation,
    foldedTranslationChain,
    localizedSlugSql,
    translationRowsSql,
    translationScopeOf,
    NAME_FIELDS,
    PRODUCT_CARD_FIELDS,
    translateRows,
    translationColumns,
    type TranslationScope,
    type TranslatedRowColumns,
} from "../translations";
import { declareNoProductRow, declareRequestedProducts, deps } from "./declare-deps";
import type { Database } from "@scalius/database/client";
import { products, categories, pages } from "@scalius/database/schema";
import { eq, sql, and, or, type SQL } from "drizzle-orm";
import {
  ftsMatch,
  isFts5SearchEnabled,
  sanitizeFtsQuery,
} from "../../search/fts5";
import {
  buildBuyerCatalogPricingProjection,
  buyerCatalogHasSkuInPriceRange,
  publicProductBaseConditions,
  quickAddEligibleSql,
} from "../products";
import { publicCategoryConditions } from "../categories";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { marketPriceContextOf, priceProductCards, type MarketPricing } from "../price-lists";
import { loadProductCardImages, priceFilterBoundsMinor } from "./shared";
import { fromMinor } from "@scalius/shared/money";
import { suggestSearchCorrection } from "./search-correction";
import { productCategoryNameMatch, productSearchRankJoin, productSearchRelevanceOrder } from "./search-relevance";

// Types for search results
export type ProductSearchResult = {
  id: string;
  name: string;
  price: number;
  discountedPrice: number;
  priceVaries: boolean;
  availableForSale: boolean;
  quickAddEligible: boolean;
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

type SearchOptions = {
  /** A presence page's market pricing (MARKETS-DESIGN D5); null at the root. */
  pricing?: MarketPricing | null;
  limit?: number;
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  searchPages?: boolean;
  searchCategories?: boolean;
  /** Buyer search: when nothing matches, retry once with the closest catalog words. */
  correctTypos?: boolean;
  /**
   * Product ids an app search provider ranked for the words (best first): the
   * product hits are these, in this order, still only public, buyable and
   * priced by core; pages and categories match the words as usual.
   */
  productIds?: readonly string[];
};

type SearchResults = {
  products: ProductSearchResult[];
  pages: PageSearchResult[];
  categories: CategorySearchResult[];
};

export async function search(
  db: Database,
  query: string,
  options?: SearchOptions,
): Promise<SearchResults & { correctedQuery: string | null }> {
  const results = await runSearch(db, query, options);
  const empty = results.products.length + results.pages.length + results.categories.length === 0;
  if (!options?.correctTypos || !empty) return { ...results, correctedQuery: null };

  const correctedQuery = await suggestSearchCorrection(db, query);
  if (!correctedQuery) return { ...results, correctedQuery: null };
  const corrected = await runSearch(db, correctedQuery, options);
  return corrected.products.length + corrected.pages.length + corrected.categories.length > 0
    ? { ...corrected, correctedQuery }
    : { ...results, correctedQuery: null };
}

async function runSearch(
  db: Database,
  query: string,
  options?: SearchOptions,
): Promise<SearchResults> {
  const limit = options?.limit || 10;
  const searchPages = options?.searchPages !== false;
  const searchCategories = options?.searchCategories !== false;
  const hasValidQuery = query && query.trim() !== "";
  const sanitizedQuery = hasValidQuery ? sanitizeFtsQuery(query) : "";
  const fts5Enabled = isFts5SearchEnabled(db);
  if (hasValidQuery && !sanitizedQuery) {
    return { products: [], pages: [], categories: [] };
  }

  // A presence's hits in its language (MARKETS-DESIGN D9); matching reads the source text.
  const translation = translationScopeOf(options?.pricing);
  // Which products, categories and pages match: their search text, the
  // public product set and the published categories (names, slugs, the
  // category filter). Each hit's own facts are declared with its card.
  deps.search();
  deps.listMembership("all");
  deps.anyCategory();
  if (searchPages) deps.anyPage();
  try {
    // Build Product Query
    // Set conditions (search hits, category) also scope the pricing projection.
    const setConditions: SQL[] = [];
    const ranked = options?.productIds ? JSON.stringify(options.productIds.slice(0, 50)) : null;
    if (ranked) {
      declareRequestedProducts(options!.productIds!.slice(0, 50));
      setConditions.push(sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${ranked}))`);
    } else if (hasValidQuery) {
      const cond = or(ftsMatch(db, "products_fts", "products", query), productCategoryNameMatch(db, query));
      if (cond) setConditions.push(cond);
    }
    if (options?.categoryId) {
      setConditions.push(
        eq(products.categoryId, options.categoryId),
        sql`EXISTS (
          SELECT 1 FROM ${categories}
          WHERE ${categories.id} = ${options.categoryId}
            AND ${and(...publicCategoryConditions())}
        )`,
      );
    }
    const productConditions: SQL[] = [...publicProductBaseConditions(), ...setConditions];
    if (
      typeof options?.minPrice === "number" ||
      typeof options?.maxPrice === "number"
    ) {
      // Any live SKU's price can move a product across the bounds.
      deps.table("product_variants");
      // A market prices its bounds in the market first (FX).
      const bounds = priceFilterBoundsMinor(
        { minPrice: options?.minPrice, maxPrice: options?.maxPrice },
        options?.pricing ? await options.pricing.context : null,
      );
      productConditions.push(
        buyerCatalogHasSkuInPriceRange(bounds.minPriceMinor, bounds.maxPriceMinor),
      );
    }
    // Scoped to the search hits (and category) so the projection ranks only
    // their SKUs, not every SKU in the store.
    const buyerPricing = buildBuyerCatalogPricingProjection(db, {
      productScope: setConditions.length > 0 ? and(...setConditions) : undefined,
    });

    const productQuery = db
      .select({
        // D1 batch rows are positionally decoded by Drizzle. Explicit aliases
        // are required for joined columns with the same database names; without
        // them, category.id can overwrite product.id and media enrichment then
        // looks up category IDs instead of products.
        id: sql<string>`${products.id}`.as("search_product_id"),
        name: sql<string>`${products.name}`.as("search_product_name"),
        basePriceMinor: buyerPricing.basePriceMinor,
        effectivePriceMinor: buyerPricing.effectivePriceMinor,
        maxBuyerPriceMinor: buyerPricing.maxBuyerPriceMinor,
        availableForSale: buyerPricing.availableForSale,
        quickAddEligible: quickAddEligibleSql(buyerPricing).as("search_quick_add_eligible"),
        hasVariants: buyerPricing.hasCustomerOptions,
        slug: sql<string>`${products.slug}`.as("search_product_slug"),
        categoryId: sql<string | null>`${categories.id}`.as("search_category_id"),
        categoryName: sql<string | null>`${categories.name}`.as("search_category_name"),
        ...(translation ? {
          trRows: translationRowsSql(translation, "product", products.id),
          trSlug: localizedSlugSql(translation, "product", products.id),
          categoryTrRows: translationRowsSql(translation, "category", categories.id),
        } : {}),
        storeCurrencyCode: storeCurrencyCodeSql().as("search_store_currency_code"),
      })
      .from(products)
      .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
      .leftJoin(categories, and(
        eq(products.categoryId, categories.id),
        ...publicCategoryConditions(),
      ))
      .$dynamic();
    const rankJoin = hasValidQuery && !ranked ? productSearchRankJoin(db, query) : undefined;
    if (rankJoin) productQuery.leftJoin(rankJoin.table, rankJoin.on);
    productQuery
      .where(and(...productConditions))
      .orderBy(...(ranked
        ? [sql`(SELECT CAST(ranked_id.key AS INTEGER) FROM json_each(${ranked}) AS ranked_id WHERE CAST(ranked_id.value AS TEXT) = ${products.id})`]
        : hasValidQuery ? productSearchRelevanceOrder(db, query) : [products.name]))
      .limit(limit);

    // Build Pages Query
    const pageConditions = [sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = 1`];
    if (hasValidQuery) {
      const pageCond = ftsMatch(db, "pages_fts", "pages", query);
      if (pageCond) pageConditions.push(pageCond);
    }
    const pageQuery = searchPages
      ? db
        .select({
          id: pages.id,
          title: pages.title,
          slug: pages.slug,
          ...translationColumns(translation, "page", pages.id),
        })
        .from(pages)
        .where(and(...pageConditions))
        .orderBy(
          hasValidQuery && fts5Enabled
            ? sql`COALESCE((SELECT rank FROM pages_fts WHERE rowid = pages.rowid AND pages_fts MATCH ${sanitizedQuery}), 0) ASC`
            : pages.title,
        )
        .limit(limit)
      : db.select({ id: sql`NULL` }).from(pages).where(sql`1 = 0`); // Dummy query

    // Build Categories Query
    const categoryConditions = publicCategoryConditions();
    if (hasValidQuery) {
      const catCond = ftsMatch(db, "categories_fts", "categories", query);
      if (catCond) categoryConditions.push(catCond);
    }
    const categoryQuery = searchCategories
      ? db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          ...translationColumns(translation, "category", categories.id),
        })
        .from(categories)
        .where(and(...categoryConditions))
        .orderBy(
          hasValidQuery && fts5Enabled
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
    const decimalPlaces = storeDecimalPlacesFromCode(productsResult[0]?.storeCurrencyCode);
    const images = await loadProductCardImages(db, productsResult.map((row) => row.id));
    if (productsResult.length === 0) declareNoProductRow();
    // The hits in the page's market (as read at the root or in a neutral market).
    const pricedHits = await priceProductCards(db, await marketPriceContextOf(options?.pricing), translateSearchProducts(translation, productsResult).map((row) => ({
      ...row,
      discountType: null,
      discountBps: 0,
      discountAmountMinor: 0,
    })));

    const formattedProducts: ProductSearchResult[] = pricedHits.map(({
      discountType: _discountType,
      discountBps: _discountBps,
      discountAmountMinor: _discountAmountMinor,
      basePriceMinor,
      effectivePriceMinor,
      maxBuyerPriceMinor,
      availableForSale,
      quickAddEligible,
      hasVariants,
      storeCurrencyCode: _storeCurrencyCode,
      ...product
    }) => {
      const image = images.get(product.id);
      return {
        ...product,
        price: fromMinor(basePriceMinor, decimalPlaces),
        discountedPrice: fromMinor(effectivePriceMinor, decimalPlaces),
        availableForSale: Boolean(availableForSale),
        quickAddEligible: Boolean(quickAddEligible),
        hasVariants: Boolean(hasVariants),
        priceVaries: maxBuyerPriceMinor > effectivePriceMinor,
        imageUrl: image?.url ?? null,
        imageMediaId: image?.mediaId ?? null,
        imageAlt: image?.alt ?? null,
        type: "product" as const,
      };
    });

    // Format pages
    const formattedPages = translateRows(translation, "page", (searchPages ? pagesResult : []).filter(
      (p) => p.id !== null
    ) as Array<{ id: string; title: string; slug: string }>, { title: "title" }).map((page) => ({
      ...page,
      type: "page" as const,
    })) as PageSearchResult[];

    // Format categories
    const formattedCategories = translateRows(translation, "category", (searchCategories ? categoriesResult : []).filter(
      (c) => c.id !== null
    ) as Array<{ id: string; name: string; slug: string }>, NAME_FIELDS).map((category) => ({
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

/** Product hits in the presence's language: the name, the handle and the category name. */
function translateSearchProducts<T extends { id: string; name: string; slug: string; categoryId: string | null; categoryName: string | null }>(
  translation: TranslationScope | null,
  rows: readonly T[],
): T[] {
  if (!translation) return rows as T[];
  deps.translations("category", rows.map((row) => row.categoryId));
  return translateRows(translation, "product", rows as Array<T & TranslatedRowColumns>, PRODUCT_CARD_FIELDS).map((row) => {
    const { categoryTrRows, ...hit } = row as typeof row & { categoryTrRows?: string | null };
    return hit.categoryId
      ? applyTranslation(hit, foldedTranslationChain(translation, categoryTrRows), { categoryName: "name" })
      : hit;
  }) as unknown as T[];
}
