// Review reads: the keys, the shapes and the query options. The sidebar's
// pending badge and the Reviews route loader load with the shell, so this file
// holds reads only; the writes live beside the Reviews screens
// (components/admin/reviews/reviews-api.ts).
import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminReviews,
  getApiV1AdminReviewsById,
  getApiV1AdminReviewsSettings,
  getApiV1AdminReviewsSummary,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { pollWhileOffline } from "../admin-query-client";

export type AdminReviewQuery = Omit<ApiQuery<typeof getApiV1AdminReviews>, "cursor">;
export type AdminReview = ApiResult<typeof getApiV1AdminReviews>["items"][number];
type ReviewSummaryPayload = ApiResult<typeof getApiV1AdminReviewsSummary>;
/** The product's rating stats; null unless the summary was asked for one product. */
export type ProductReviewStats = NonNullable<ReviewSummaryPayload["product"]>;
export type AdminReviewSummary = Omit<ReviewSummaryPayload, "product"> & { product: ProductReviewStats | null };
export type ReviewSettings = ApiResult<typeof getApiV1AdminReviewsSettings>;

export const reviewKeys = {
  all: ["reviews"] as const,
  lists: () => [...reviewKeys.all, "list"] as const,
  list: (query: AdminReviewQuery) => [...reviewKeys.lists(), query] as const,
  summary: (productId?: string) => [...reviewKeys.all, "summary", productId ?? null] as const,
  detail: (id: string) => [...reviewKeys.all, "detail", id] as const,
  settings: () => [...reviewKeys.all, "settings"] as const,
};

/** Live through the realtime hub; this poll runs only while it is unreachable. */
const SUMMARY_POLL_MS = 60_000;

/** Counts per status (the tabs and the sidebar badge), plus one product's stats when asked. */
export const reviewSummaryQueryOptions = (productId?: string) =>
  queryOptions({
    queryKey: reviewKeys.summary(productId),
    queryFn: async (): Promise<AdminReviewSummary> =>
      apiData(getApiV1AdminReviewsSummary(productId ? { query: { productId } } : undefined)),
    refetchInterval: pollWhileOffline(SUMMARY_POLL_MS),
    staleTime: 30_000,
  });

/** Reviews per page of the moderation queue (the API's own page). */
export const REVIEW_PAGE_SIZE = 25;

/** One page of the moderation queue, newest first, after `cursor` (keyset). */
export const reviewListQueryOptions = (query: AdminReviewQuery, cursor = "") =>
  queryOptions({
    queryKey: [...reviewKeys.list(query), cursor] as const,
    queryFn: () => apiData(getApiV1AdminReviews({ query: { ...query, ...(cursor ? { cursor } : {}) } })),
    staleTime: 15_000,
  });

export const reviewQueryOptions = (id: string) =>
  queryOptions({
    queryKey: reviewKeys.detail(id),
    queryFn: () => apiData(getApiV1AdminReviewsById({ path: { id } })),
    staleTime: 0,
  });

export const reviewSettingsQueryOptions = () =>
  queryOptions({
    queryKey: reviewKeys.settings(),
    queryFn: () => apiData(getApiV1AdminReviewsSettings()),
    staleTime: 0,
  });
