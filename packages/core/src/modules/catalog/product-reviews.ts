// Public product reviews (Wave B §2.4): the summary from the
// `product_review_stats` projection and published reviews in keyset pages.
// The product page reads the first page in its existing wave; the public list
// (`GET /products/{id}/reviews`) reads the rest. Only published reviews, only
// the buyer-safe fields: no order, customer or moderation facts. The catalogue
// reads these tables through its own selects, never through the reviews
// domain (no catalog -> reviews edge).
import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { productReviews, productReviewStats, products } from "@scalius/database/schema";
import { reviewsEnabledSql } from "../settings/documents";
import { deps } from "./declare-deps";

export const PUBLIC_REVIEW_SORTS = ["recent", "highest", "lowest"] as const;
export type PublicReviewSort = (typeof PUBLIC_REVIEW_SORTS)[number];
export const PUBLIC_REVIEW_PAGE_SIZE = { default: 10, max: 20 } as const;
/** Reviews the product page renders server-side (and describes in JSON-LD). */
export const PRODUCT_PAGE_REVIEW_COUNT = 5;

/** Published-review aggregates of one product. */
export interface PublicReviewSummary {
  /** Average rating truncated to two decimals (4.66); 0 with no published review. */
  average: number;
  count: number;
  /** Counts per star, 5★ first. */
  histogram: Array<{ rating: number; count: number }>;
}

export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  authorName: string;
  variantLabel: string | null;
  /** Every review comes from a delivered order line. */
  verifiedPurchase: true;
  publishedAt: string;
  editedAt: string | null;
  /** The merchant's public reply ("Response from <store>"). */
  reply: { body: string; repliedAt: string } | null;
}

export interface PublicReviewPage {
  items: PublicReview[];
  nextCursor: string | null;
}

/** The product page's `reviews` field: null when reviews are off. */
export interface ProductPageReviews extends PublicReviewPage {
  summary: PublicReviewSummary;
}

/** The stats columns the product page reads with its product row. */
export interface ReviewStatsColumns {
  reviewCount: number | null;
  ratingAvgCenti: number | null;
  count1: number | null;
  count2: number | null;
  count3: number | null;
  count4: number | null;
  count5: number | null;
}

/** Columns to add to a product-row select that LEFT JOINs `product_review_stats` by product id. */
export function reviewStatsSelection() {
  return {
    reviewsEnabled: reviewsEnabledSql(),
    reviewCount: productReviewStats.reviewCount,
    ratingAvgCenti: productReviewStats.ratingAvgCenti,
    count1: productReviewStats.count1,
    count2: productReviewStats.count2,
    count3: productReviewStats.count3,
    count4: productReviewStats.count4,
    count5: productReviewStats.count5,
  };
}

export function presentReviewSummary(stats: ReviewStatsColumns): PublicReviewSummary {
  const count = stats.reviewCount ?? 0;
  return {
    average: count > 0 ? (stats.ratingAvgCenti ?? 0) / 100 : 0,
    count,
    histogram: [
      { rating: 5, count: stats.count5 ?? 0 },
      { rating: 4, count: stats.count4 ?? 0 },
      { rating: 3, count: stats.count3 ?? 0 },
      { rating: 2, count: stats.count2 ?? 0 },
      { rating: 1, count: stats.count1 ?? 0 },
    ],
  };
}

type ReviewCursor = { publishedAt: number; id: string; rating: number };

function encodeCursor(cursor: ReviewCursor): string {
  return btoa(JSON.stringify([cursor.publishedAt, cursor.id, cursor.rating])).replace(/=+$/, "");
}

export function decodePublicReviewCursor(value: string | null | undefined): ReviewCursor | null {
  if (!value || value.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (
      Array.isArray(parsed)
      && Number.isSafeInteger(parsed[0])
      && typeof parsed[1] === "string" && parsed[1].length <= 80
      && Number.isInteger(parsed[2]) && parsed[2] >= 1 && parsed[2] <= 5
    ) {
      return { publishedAt: parsed[0] as number, id: parsed[1], rating: parsed[2] as number };
    }
  } catch {
    // An unreadable cursor restarts the list.
  }
  return null;
}

function isoFromSeconds(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/** After the cursor, newest first within one rating. */
function newerThan(cursor: ReviewCursor): SQL {
  return or(
    lt(productReviews.publishedAt, cursor.publishedAt),
    and(eq(productReviews.publishedAt, cursor.publishedAt), lt(productReviews.id, cursor.id)),
  )!;
}

function afterCursor(sort: PublicReviewSort, cursor: ReviewCursor): SQL {
  if (sort === "recent") return newerThan(cursor);
  const byRating = sort === "highest" ? lt(productReviews.rating, cursor.rating) : gt(productReviews.rating, cursor.rating);
  return or(byRating, and(eq(productReviews.rating, cursor.rating), newerThan(cursor)))!;
}

function orderFor(sort: PublicReviewSort): SQL[] {
  const recent = [desc(productReviews.publishedAt), desc(productReviews.id)];
  if (sort === "highest") return [desc(productReviews.rating), ...recent];
  if (sort === "lowest") return [asc(productReviews.rating), ...recent];
  return recent;
}

export interface PublicReviewQuery {
  sort?: PublicReviewSort;
  /** Only reviews with this many stars (the histogram's filter links). */
  rating?: number;
  cursor?: string | null;
  limit?: number;
}

/**
 * One page of a product's published reviews. Reads the product's slice of
 * `(product_id, status, published_at DESC, id)`; the rating sorts and filter
 * order that slice, never the whole table.
 */
export async function readPublishedReviews(
  db: Database,
  productId: string,
  query: PublicReviewQuery = {},
): Promise<PublicReviewPage> {
  const sort = query.sort ?? "recent";
  const limit = Math.max(1, Math.min(PUBLIC_REVIEW_PAGE_SIZE.max, query.limit ?? PUBLIC_REVIEW_PAGE_SIZE.default));
  const conditions: SQL[] = [eq(productReviews.productId, productId), eq(productReviews.status, "published")];
  if (query.rating !== undefined) conditions.push(eq(productReviews.rating, query.rating));
  const cursor = decodePublicReviewCursor(query.cursor);
  if (cursor) conditions.push(afterCursor(sort, cursor));
  const rows = await db
    .select({
      id: productReviews.id,
      rating: productReviews.rating,
      title: productReviews.title,
      body: productReviews.body,
      authorName: productReviews.authorDisplayName,
      variantLabel: productReviews.variantLabel,
      publishedAt: productReviews.publishedAt,
      editedAt: productReviews.editedAt,
      replyBody: productReviews.replyBody,
      repliedAt: productReviews.repliedAt,
    })
    .from(productReviews)
    .where(and(...conditions))
    .orderBy(...orderFor(sort))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      rating: row.rating,
      title: row.title,
      body: row.body,
      authorName: row.authorName,
      variantLabel: row.variantLabel,
      verifiedPurchase: true as const,
      publishedAt: isoFromSeconds(row.publishedAt ?? 0)!,
      editedAt: isoFromSeconds(row.editedAt),
      reply: row.replyBody && row.repliedAt !== null ? { body: row.replyBody, repliedAt: isoFromSeconds(row.repliedAt)! } : null,
    })),
    nextCursor: rows.length > limit && last
      ? encodeCursor({ publishedAt: last.publishedAt ?? 0, id: last.id, rating: last.rating })
      : null,
  };
}

/**
 * The public review list of a buyer-visible product (active, not deleted),
 * with its summary; `null` when the product is not public or reviews are off
 * (the route answers 404).
 */
export async function getPublicProductReviews(
  db: Database,
  productId: string,
  query: PublicReviewQuery = {},
): Promise<ProductPageReviews | null> {
  // The product's buyer state, its review stats and its published reviews.
  deps.product(productId);
  const product = await db
    .select({ id: products.id, ...reviewStatsSelection() })
    .from(products)
    .leftJoin(productReviewStats, eq(productReviewStats.productId, products.id))
    .where(and(eq(products.id, productId), eq(products.isActive, true), isNull(products.deletedAt)))
    .get();
  if (!product || Number(product.reviewsEnabled) !== 1) return null;
  const summary = presentReviewSummary(product);
  if (summary.count === 0) return { summary, items: [], nextCursor: null };
  return { summary, ...await readPublishedReviews(db, productId, query) };
}

/**
 * The product page's reviews from the stats the product row already read:
 * `null` when reviews are off, the summary alone at zero reviews (no query),
 * else the first five most recent published reviews (one indexed read in the
 * page's existing wave).
 */
export async function productPageReviews(
  db: Database,
  productId: string,
  stats: ReviewStatsColumns & { reviewsEnabled: number | null },
): Promise<ProductPageReviews | null> {
  if (Number(stats.reviewsEnabled) !== 1) return null;
  const summary = presentReviewSummary(stats);
  if (summary.count === 0) return { summary, items: [], nextCursor: null };
  return { summary, ...await readPublishedReviews(db, productId, { limit: PRODUCT_PAGE_REVIEW_COUNT }) };
}
