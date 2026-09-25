// Product reviews on the storefront (Wave B §2.4): the pure pieces every
// review surface shares. That covers the product page summary and module,
// the /products/<slug>/reviews page and the "Show more" script. Review text
// is buyer content: it is escaped on the way into HTML and never goes into a
// URL, a log line or analytics.
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { escapeHtml } from "@scalius/shared/html-escape";
import type { ProductReviews, ProductReviewSummary, PublicProductReview } from "@/lib/api/types";

/** The public list's sorts (`GET /products/{id}/reviews?sort=`); "recent" is the default and stays out of URLs. */
export const REVIEW_SORTS = ["recent", "highest", "lowest"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

/** Reviews the product page renders on the server (and describes in JSON-LD). */
export const PRODUCT_PAGE_REVIEWS = 5;
/** Reviews per "Show more" and per page of /products/<slug>/reviews (the API's cap is 20). */
export const REVIEW_PAGE_SIZE = 10;

/** The copy every review surface reads (checkout language: en or bn, with the merchant's edits where they exist). */
export const REVIEW_COPY_KEYS = [
  "reviewsTitleText",
  "reviewsCountOneText",
  "reviewsCountText",
  "reviewsRatingsCountOneText",
  "reviewsRatingsCountText",
  "reviewsAverageText",
  "reviewsRatedText",
  "reviewsStarRowText",
  "reviewsStarShareText",
  "reviewsSortLabelText",
  "reviewsSortRecentText",
  "reviewsSortHighestText",
  "reviewsSortLowestText",
  "reviewsFilterAllText",
  "reviewsFilteredText",
  "reviewsFilterEmptyText",
  "reviewsShowMoreText",
  "reviewsSeeAllText",
  "reviewsLoadFailedText",
  "reviewsVerifiedText",
  "reviewsEditedText",
  "reviewsReplyText",
  "reviewsReplyFallbackText",
  "reviewsEmptyText",
  "reviewsPageTitleText",
  "reviewsBackToProductText",
  "reviewsNextPageText",
  "reviewsFirstPageText",
] as const satisfies ReadonlyArray<keyof CheckoutLanguageData>;

export type ReviewCopy = Pick<CheckoutLanguageData, (typeof REVIEW_COPY_KEYS)[number]>;

export function pickReviewCopy(copy: CheckoutLanguageData): ReviewCopy {
  return Object.fromEntries(REVIEW_COPY_KEYS.map((key) => [key, copy[key]])) as ReviewCopy;
}

/** The words one review needs. */
export type ReviewListCopy = Pick<
  ReviewCopy,
  "reviewsRatedText" | "reviewsEditedText" | "reviewsVerifiedText" | "reviewsReplyText" | "reviewsReplyFallbackText"
>;

/** How a review list is rendered: the language of dates and the store name in "Response from …". */
export interface ReviewRenderOptions {
  copy: ReviewListCopy;
  /** Base language code ("en", "bn") for dates. */
  language: string;
  /** The store's name from Business settings; null uses "Response from the store". */
  storeName: string | null;
}

// ─── Reading the API ────────────────────────────────────────────────────

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);
const isoDate = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

function readSummary(value: unknown): ProductReviewSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const total = count(raw.count);
  const average = typeof raw.average === "number" && Number.isFinite(raw.average) ? Math.min(Math.max(raw.average, 0), 5) : 0;
  const byRating = new Map<number, number>();
  if (Array.isArray(raw.histogram)) {
    for (const row of raw.histogram) {
      if (!row || typeof row !== "object") continue;
      const { rating, count: rowCount } = row as Record<string, unknown>;
      if (typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5) byRating.set(rating, count(rowCount));
    }
  }
  return {
    average: total > 0 ? average : 0,
    count: total,
    histogram: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: byRating.get(rating) ?? 0 })),
  };
}

/** One published review from the API; null when it is malformed (it is then left out, never guessed). */
export function readPublicReview(value: unknown): PublicProductReview | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const rating = raw.rating;
  const publishedAt = isoDate(raw.publishedAt);
  if (typeof raw.id !== "string" || !raw.id || typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5 || !publishedAt) {
    return null;
  }
  const reply = raw.reply && typeof raw.reply === "object" ? raw.reply as Record<string, unknown> : null;
  const replyBody = text(reply?.body);
  const repliedAt = isoDate(reply?.repliedAt);
  return {
    id: raw.id,
    rating,
    title: text(raw.title),
    body: text(raw.body),
    authorName: text(raw.authorName) ?? "",
    variantLabel: text(raw.variantLabel),
    verifiedPurchase: true,
    publishedAt,
    editedAt: isoDate(raw.editedAt),
    reply: replyBody && repliedAt ? { body: replyBody, repliedAt } : null,
  };
}

/**
 * The product page's `reviews` (or one page of the public list): null when
 * reviews are off or the payload is unreadable, so nothing is shown rather
 * than a wrong summary.
 */
export function readProductReviews(value: unknown): ProductReviews | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const summary = readSummary(raw.summary);
  if (!summary) return null;
  const items = Array.isArray(raw.items)
    ? raw.items.map(readPublicReview).filter((review): review is PublicProductReview => review !== null)
    : [];
  return {
    summary,
    items: summary.count > 0 ? items : [],
    nextCursor: summary.count > 0 && typeof raw.nextCursor === "string" && raw.nextCursor ? raw.nextCursor : null,
  };
}

// ─── Numbers ────────────────────────────────────────────────────────────

/** The average as buyers and JSON-LD read it: one decimal ("4.7"). */
export function formatReviewAverage(average: number): string {
  const clamped = Math.min(Math.max(average, 0), 5);
  return (Math.round(clamped * 10) / 10).toFixed(1);
}

/** The star fill for an average, to the nearest half star (Amazon's rounding): "90%" for 4.6. */
export function reviewStarFill(average: number): string {
  const halves = Math.round(Math.min(Math.max(average, 0), 5) * 2);
  return `${halves * 10}%`;
}

/** "128 reviews" / "1 review" (Latin digits, grouped the South Asian way). */
export function reviewCountText(copy: Pick<ReviewCopy, "reviewsCountOneText" | "reviewsCountText">, total: number): string {
  return total === 1
    ? copy.reviewsCountOneText
    : formatCheckoutLanguageText(copy.reviewsCountText, { count: total.toLocaleString("en-IN") });
}

export interface ReviewHistogramRow {
  rating: number;
  count: number;
  /** Whole percent of all reviews, as Amazon labels its bars. */
  percent: number;
}

/** The five bars, 5★ first; percents are rounded and 0 without reviews. */
export function reviewHistogram(summary: ProductReviewSummary): ReviewHistogramRow[] {
  return [5, 4, 3, 2, 1].map((rating) => {
    const rowCount = summary.histogram.find((row) => row.rating === rating)?.count ?? 0;
    return { rating, count: rowCount, percent: summary.count > 0 ? Math.round((rowCount / summary.count) * 100) : 0 };
  });
}

export function formatReviewDate(iso: string, language: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(language === "bn" ? "bn-BD" : "en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

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

/** The full review page of a product for a view (no JavaScript, and the "See all" link). */
export function productReviewsPageHref(slug: string, view: Partial<ReviewListView> & { after?: string | null } = {}): string {
  const params = new URLSearchParams();
  if (view.rating) params.set("rating", String(view.rating));
  if (view.sort && view.sort !== "recent") params.set("sort", view.sort);
  if (view.after) params.set("after", view.after);
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

// ─── Markup (server and "Show more" render the same HTML) ───────────────

/** Five stars filled to `value` (decorative; the words go beside them). */
export function starsMarkup(value: number, className = ""): string {
  return `<span class="sc-stars${className ? ` ${escapeHtml(className)}` : ""}" style="--sc-fill:${reviewStarFill(value)}" aria-hidden="true"></span>`;
}

function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * One review as Amazon and Daraz show it: the name, the stars and title on one
 * line, the date with "Edited", the variant bought and "Verified purchase",
 * the text, then the store's reply indented under it.
 */
export function publicReviewMarkup(review: PublicProductReview, options: ReviewRenderOptions): string {
  const { copy, language, storeName } = options;
  const rated = formatCheckoutLanguageText(copy.reviewsRatedText, { average: String(review.rating) });
  const date = formatReviewDate(review.publishedAt, language);
  const meta = [
    `<time datetime="${escapeHtml(review.publishedAt)}">${escapeHtml(date)}</time>`,
    review.editedAt ? `<span>${escapeHtml(copy.reviewsEditedText)}</span>` : "",
  ].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  const facts = [
    review.variantLabel ? `<span class="review-variant">${escapeHtml(review.variantLabel)}</span>` : "",
    `<span class="review-verified">${escapeHtml(copy.reviewsVerifiedText)}</span>`,
  ].filter(Boolean).join('<span aria-hidden="true" class="review-sep">|</span>');
  const replyTitle = storeName
    ? formatCheckoutLanguageText(copy.reviewsReplyText, { store: storeName })
    : copy.reviewsReplyFallbackText;
  const reply = review.reply
    ? `<div class="review-reply"><p class="review-reply-title">${escapeHtml(replyTitle)}<span class="review-reply-date"> · <time datetime="${escapeHtml(review.reply.repliedAt)}">${escapeHtml(formatReviewDate(review.reply.repliedAt, language))}</time></span></p><div class="review-body">${paragraphs(review.reply.body)}</div></div>`
    : "";
  return `<li class="review" data-review-id="${escapeHtml(review.id)}">`
    + `<p class="review-author">${escapeHtml(review.authorName)}</p>`
    + `<p class="review-headline">${starsMarkup(review.rating, "review-stars")}<span class="sr-only">${escapeHtml(rated)}</span>`
    + (review.title ? `<span class="review-title">${escapeHtml(review.title)}</span>` : "")
    + `</p>`
    + `<p class="review-meta">${meta}</p>`
    + `<p class="review-facts">${facts}</p>`
    + (review.body ? `<div class="review-body">${paragraphs(review.body)}</div>` : "")
    + reply
    + `</li>`;
}

export function publicReviewListMarkup(reviews: readonly PublicProductReview[], options: ReviewRenderOptions): string {
  return reviews.map((review) => publicReviewMarkup(review, options)).join("");
}
