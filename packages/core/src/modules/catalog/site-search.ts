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
import { desc, eq, sql, and, or, type SQL } from "drizzle-orm";
import {
  sanitizeFtsQuery,
  searchMatch,
  searchRank,
} from "../../search";
import {
  buyerCatalogHasSkuInPriceRange,
  quickAddEligibleSql,
} from "../products";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";
import { publicCategoryConditions } from "../categories";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { marketPriceContextOf, priceProductCards, type MarketPricing } from "../price-lists";
import { loadProductCardImages, priceFilterBoundsMinor } from "./shared";
import { fromMinor } from "@scalius/shared/money";
import { suggestSearchCorrection } from "./search-correction";
import { productCategoryNameMatch, productSearchRank, productSearchRelevanceOrder } from "./search-relevance";

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
  if (hasValidQuery && !sanitizeFtsQuery(query)) {
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
    // Build Product Query. The public set, the category filter and every
    // hit's price and availability are the stored buyer state's, as on a
    // listing, so `lm:all` and the hits' own `p:` keys cover exactly the rows
    // read. Public eligibility evaluated live (is_active, deleted_at, the
    // SKU topology) let a direct SQL write that leaves the buyer state as it
    // was bring in a product the answer had declared no key of.
    const productConditions: SQL[] = [publicBuyerStateCondition({ drivenByIdSet: true })];
    const ranked = options?.productIds ? JSON.stringify(options.productIds.slice(0, 50)) : null;
    if (ranked) {
      declareRequestedProducts(options!.productIds!.slice(0, 50));
      productConditions.push(sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${ranked}))`);
    } else if (hasValidQuery) {
      const cond = or(searchMatch(db, "products", query), productCategoryNameMatch(db, query));
      if (cond) productConditions.push(cond);
    }
    if (options?.categoryId) {
      productConditions.push(
        eq(buyerState.categoryId, options.categoryId),
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
      // Any live SKU's price, and the product discount it falls back to
      // (`lo:price`), can move a product across the bounds, as on a listing.
      deps.table("product_variants");
      deps.listOrder("price", "all");
      // A market prices its bounds in the market first (FX).
      const bounds = priceFilterBoundsMinor(
        { minPrice: options?.minPrice, maxPrice: options?.maxPrice },
        options?.pricing ? await options.pricing.context : null,
      );
      productConditions.push(
        buyerCatalogHasSkuInPriceRange(bounds.minPriceMinor, bounds.maxPriceMinor),
      );
    }

    const productQuery = db
      .select({
        // D1 batch rows are positionally decoded by Drizzle. Explicit aliases
        // are required for joined columns with the same database names; without
        // them, category.id can overwrite product.id and media enrichment then
        // looks up category IDs instead of products.
        id: sql<string>`${products.id}`.as("search_product_id"),
        name: sql<string>`${products.name}`.as("search_product_name"),
        basePriceMinor: sql<number>`${buyerState.baseMinor}`.as("search_base_minor"),
        effectivePriceMinor: sql<number>`${buyerState.fromMinor}`.as("search_from_minor"),
        maxBuyerPriceMinor: sql<number>`${buyerState.toMinor}`.as("search_to_minor"),
        availableForSale: sql<number>`${buyerState.availableForSale}`.as("search_available_for_sale"),
        quickAddEligible: quickAddEligibleSql({
          availableForSale: buyerState.availableForSale,
          hasCustomerOptions: buyerState.hasCustomerOptions,
          effectivePriceMinor: buyerState.fromMinor,
        }).as("search_quick_add_eligible"),
        hasVariants: sql<number>`${buyerState.hasCustomerOptions}`.as("search_has_customer_options"),
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
      .innerJoin(buyerState, eq(buyerState.productId, products.id))
      .leftJoin(categories, and(
        eq(products.categoryId, categories.id),
        ...publicCategoryConditions(),
      ))
      .$dynamic();
    const rankJoin = hasValidQuery && !ranked ? productSearchRank(db, query)?.join : undefined;
    if (rankJoin) productQuery.leftJoin(rankJoin.table, rankJoin.on);
    productQuery
      .where(and(...productConditions))
      .orderBy(...(ranked
        ? [sql`(SELECT CAST(ranked_id.key AS INTEGER) FROM json_each(${ranked}) AS ranked_id WHERE CAST(ranked_id.value AS TEXT) = ${products.id})`]
        : hasValidQuery ? productSearchRelevanceOrder(db, query) : [products.name]),
        // Equal ranks read newest first, then by id, as on a listing.
        desc(buyerState.productCreatedAt), buyerState.productId)
      .limit(limit);

    // Build Pages Query
    const pageConditions = [sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = 1`];
    if (hasValidQuery) {
      const pageCond = searchMatch(db, "pages", query);
      if (pageCond) pageConditions.push(pageCond);
    }
    // Best match first (FTS5 rank), then by title.
    const pageRank = hasValidQuery && searchPages ? searchRank(db, "pages", query, { alias: "page_rank" }) : undefined;
    const pageQuery = db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        ...translationColumns(translation, "page", pages.id),
      })
      .from(pages)
      .$dynamic();
    if (pageRank?.join) pageQuery.leftJoin(pageRank.join.table, pageRank.join.on);
    pageQuery
      .where(searchPages ? and(...pageConditions) : sql`1 = 0`)
      .orderBy(...(pageRank ? [pageRank.score] : []), pages.title, pages.id)
      .limit(limit);

    // Build Categories Query
    const categoryConditions = publicCategoryConditions();
    if (hasValidQuery) {
      const catCond = searchMatch(db, "categories", query);
      if (catCond) categoryConditions.push(catCond);
    }
    const categoryRank = hasValidQuery && searchCategories ? searchRank(db, "categories", query, { alias: "category_rank" }) : undefined;
    const categoryQuery = db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        ...translationColumns(translation, "category", categories.id),
      })
      .from(categories)
      .$dynamic();
    if (categoryRank?.join) categoryQuery.leftJoin(categoryRank.join.table, categoryRank.join.on);
    categoryQuery
      .where(searchCategories ? and(...categoryConditions) : sql`1 = 0`)
      .orderBy(...(categoryRank ? [categoryRank.score] : []), categories.name, categories.id)
      .limit(limit);

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
