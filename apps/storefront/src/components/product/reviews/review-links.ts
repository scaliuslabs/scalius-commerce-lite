// Product review lists' sorts, page sizes and URLs: what the product page's
// script needs on first paint. The markup and the readers of a list it
// loads (review-format.ts, which re-exports these) load with the first
// "Show more", sort or star filter.

/** The public list's sorts (`GET /products/{id}/reviews?sort=`); "recent" is the default and stays out of URLs. */
export const REVIEW_SORTS = ["recent", "highest", "lowest"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

/** Reviews the product page renders on the server (and describes in JSON-LD). */
export const PRODUCT_PAGE_REVIEWS = 5;
/** Reviews per "Show more" and per page of /products/<slug>/reviews (the API's cap is 20). */
export const REVIEW_PAGE_SIZE = 10;

// ─── URLs (no review text ever goes into one) ───────────────────────────

export interface ReviewListView {
  sort: ReviewSort;
  /** Only reviews with this many stars (a histogram bar). */
  rating: number | null;
}

export const DEFAULT_REVIEW_VIEW: ReviewListView = { sort: "recent", rating: null };

/** `?sort=&rating=` of a review list URL; anything unknown reads as the default view. */
export function readReviewListView(params: URLSearchParams): ReviewListView & { cursor: string | null } {
  const sort = params.get("sort");
  const rating = params.get("rating");
  const cursor = params.get("after");
  return {
    sort: (REVIEW_SORTS as readonly string[]).includes(sort ?? "") ? sort as ReviewSort : "recent",
    rating: rating && /^[1-5]$/.test(rating) ? Number(rating) : null,
    cursor: cursor && /^[A-Za-z0-9+/_-]{1,200}$/.test(cursor) ? cursor : null,
  };
}

/**
 * The full review page of a product for a view (no JavaScript, and the "See all" link). The query is written in
 * the shared cache's canonical order (keys sorted: after, rating, sort): the edge renders that form, and the page
 * redirects any other spelling of its view to this one, so a differently ordered link would redirect forever for a
 * buyer served from the edge. (`review-format.test.ts` checks it against `canonicalizeStorefrontHtmlCachePath`,
 * which this first-paint module must not import.)
 */
export function productReviewsPageHref(slug: string, view: Partial<ReviewListView> & { after?: string | null } = {}): string {
  const params = new URLSearchParams();
  if (view.after) params.set("after", view.after);
  if (view.rating) params.set("rating", String(view.rating));
  if (view.sort && view.sort !== "recent") params.set("sort", view.sort);
  const query = params.toString();
  return `/products/${encodeURIComponent(slug)}/reviews${query ? `?${query}` : ""}`;
}

/** The same-origin proxy the product page's script reads further pages from. */
export function productReviewsProxyHref(productId: string, view: ReviewListView & { cursor?: string | null; limit?: number }): string {
  const params = new URLSearchParams();
  if (view.sort !== "recent") params.set("sort", view.sort);
  if (view.rating) params.set("rating", String(view.rating));
  if (view.cursor) params.set("cursor", view.cursor);
  if (view.limit) params.set("limit", String(view.limit));
  const query = params.toString();
  return `/api/reviews/${encodeURIComponent(productId)}${query ? `?${query}` : ""}`;
}
