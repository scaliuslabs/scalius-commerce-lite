// The Reviews page URL state: which tab (status), the star filter, one
// product, the search term and the open review. Product and review ids are
// opaque; review text and reviewer names never enter the URL beyond what the
// merchant typed into the search box.
import type { AdminReviewQuery } from "~/lib/api-query-options/reviews";

export const REVIEW_TABS = ["pending", "published", "rejected"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

export interface ReviewSearch {
  /** Omitted for Pending, the default tab. */
  status?: "published" | "rejected";
  rating?: 1 | 2 | 3 | 4 | 5;
  productId?: string;
  q?: string;
  /** The review open in the side sheet. */
  review?: string;
}

export type ReviewSearchChange = (next: Partial<ReviewSearch>, options?: { replace?: boolean }) => void;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function opaqueId(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : undefined;
}

export function validateReviewSearch(input: Record<string, unknown>): ReviewSearch {
  const search: ReviewSearch = {};
  if (input.status === "published" || input.status === "rejected") search.status = input.status;
  const rating = typeof input.rating === "string" && /^[1-5]$/.test(input.rating) ? Number(input.rating) : input.rating;
  if (rating === 1 || rating === 2 || rating === 3 || rating === 4 || rating === 5) search.rating = rating;
  const productId = opaqueId(input.productId);
  if (productId) search.productId = productId;
  if (typeof input.q === "string" && input.q.trim()) search.q = input.q.trim().slice(0, 100);
  const review = opaqueId(input.review);
  if (review) search.review = review;
  return search;
}

export function reviewTab(search: ReviewSearch): ReviewTab {
  return search.status ?? "pending";
}

/** The tab a review sits on (withdrawn reviews have none: they open over Pending). */
export function tabForStatus(status: string): ReviewSearch["status"] {
  return status === "published" || status === "rejected" ? status : undefined;
}

/** The list request for the page's URL state. */
export function reviewListQuery(search: ReviewSearch): AdminReviewQuery {
  return {
    status: reviewTab(search),
    ...(search.rating ? { rating: search.rating } : {}),
    ...(search.productId ? { productId: search.productId } : {}),
    ...(search.q ? { q: search.q } : {}),
  };
}
