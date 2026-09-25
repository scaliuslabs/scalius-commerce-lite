// Review writes: moderation, the store's reply, the reviewer thread and the
// settings. Reads live in lib/api-query-options/reviews.ts. Staff never write a
// buyer's rating, title or text: there is no call here that could.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  postApiV1AdminReviewsByIdConversation,
  postApiV1AdminReviewsModerate,
  putApiV1AdminReviewsByIdReply,
  putApiV1AdminReviewsSettings,
} from "@scalius/api-client/sdk";
import { REVIEW_LIMITS, REVIEW_REQUEST_DELAY_DAYS, type ReviewRejectionReason } from "@scalius/shared/reviews";
import type { SearchableSelectLoader } from "~/components/ui/searchable-select";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiData, type ApiBody, type ApiResult } from "~/lib/api";
import { fetchProducts } from "~/lib/api-query-options/products";
import { reviewKeys, type ReviewSettings } from "~/lib/api-query-options/reviews";
import { newRequestKey } from "../inbox/inbox-api";

export type ModerationAction = "publish" | "reject" | "restore";
export type ModerateBody = ApiBody<typeof postApiV1AdminReviewsModerate>;
export type ModerateResult = ApiResult<typeof postApiV1AdminReviewsModerate>;
export type ReviewSettingsBody = ApiBody<typeof putApiV1AdminReviewsSettings>;

/** One moderation request holds at most 90 ids (D1's bound-parameter budget). */
export const MODERATION_BATCH = 90;

/**
 * The body of one moderation click. A rejection needs a content reason (a
 * low rating never is one); every request carries a fresh key so a retried
 * network call is applied once.
 */
export function moderationBody(ids: readonly string[], action: ModerationAction, reason?: ReviewRejectionReason): ModerateBody {
  if (ids.length === 0 || ids.length > MODERATION_BATCH) throw new Error(`Moderate 1 to ${MODERATION_BATCH} reviews at a time`);
  if (action === "reject" && !reason) throw new Error("Rejecting reviews needs a reason");
  return {
    ids: [...ids],
    action,
    ...(action === "reject" ? { reason } : {}),
    requestKey: newRequestKey(),
  };
}

/** Moderates any number of reviews, 90 per request, one after another. */
export async function moderateReviews(ids: readonly string[], action: ModerationAction, reason?: ReviewRejectionReason): Promise<ModerateResult> {
  const result: ModerateResult = { updated: [], skipped: [] };
  for (let start = 0; start < ids.length; start += MODERATION_BATCH) {
    const body = moderationBody(ids.slice(start, start + MODERATION_BATCH), action, reason);
    const chunk = await apiData(postApiV1AdminReviewsModerate({ body }));
    result.updated.push(...chunk.updated);
    result.skipped.push(...chunk.skipped);
  }
  return result;
}

/** A reject is undone by a restore only for reviews that were live before it. */
export function undoableRejection(result: ModerateResult): string[] {
  return result.updated.filter((row) => row.previousStatus === "published").map((row) => row.id);
}

export function useModerateReviews() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: readonly string[]; action: ModerationAction; reason?: ReviewRejectionReason }) =>
      moderateReviews(input.ids, input.action, input.reason),
    onSettled: () => queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
  });
}

export function isConflict(error: unknown): boolean {
  return error instanceof AdminApiResponseError && error.status === 409;
}

/** Sets (or, with `null`, removes) the store's public reply, guarded by the review version. */
export function useSaveReply(reviewId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string | null; version: number }) =>
      apiData(putApiV1AdminReviewsByIdReply({ path: { id: reviewId }, body: input })),
    onSuccess: (review) => {
      queryClient.setQueryData(reviewKeys.detail(review.id), review);
      void queryClient.invalidateQueries({ queryKey: reviewKeys.lists() });
    },
    onError: (error) => {
      if (isConflict(error)) void queryClient.invalidateQueries({ queryKey: reviewKeys.detail(reviewId) });
    },
  });
}

/** Opens (or reuses) the private conversation with the reviewer. */
export function useOpenReviewThread() {
  return useMutation({
    mutationFn: async (reviewId: string) =>
      (await apiData(postApiV1AdminReviewsByIdConversation({ path: { id: reviewId } }))).conversationId,
  });
}

export interface ReviewSettingsForm {
  enabled: boolean;
  moderation: "auto" | "hold";
  requestsEnabled: boolean;
  /** As typed in the field. */
  requestDelayDays: string;
  /** One word or phrase per line, as typed. */
  blockWords: string;
}

export function settingsForm(settings: ReviewSettings): ReviewSettingsForm {
  return {
    enabled: settings.enabled,
    moderation: settings.moderation,
    requestsEnabled: settings.requestsEnabled,
    requestDelayDays: String(settings.requestDelayDays),
    blockWords: settings.blockWords.join("\n"),
  };
}

export function parseBlockWords(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const word = line.trim().replace(/\s+/g, " ");
    const key = word.toLocaleLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

export type ReviewSettingsError = "delayInvalid" | "blockWordsTooMany" | "blockWordTooLong";

/** The request body for the settings form, or the first thing to fix. */
export function settingsBody(
  form: ReviewSettingsForm,
  expectedRevision: number,
): { ok: true; body: ReviewSettingsBody } | { ok: false; error: ReviewSettingsError } {
  const days = form.requestDelayDays.trim();
  const delay = /^\d+$/.test(days) ? Number(days) : Number.NaN;
  if (!Number.isInteger(delay) || delay < REVIEW_REQUEST_DELAY_DAYS.min || delay > REVIEW_REQUEST_DELAY_DAYS.max) {
    return { ok: false, error: "delayInvalid" };
  }
  const blockWords = parseBlockWords(form.blockWords);
  if (blockWords.length > REVIEW_LIMITS.blockWords) return { ok: false, error: "blockWordsTooMany" };
  if (blockWords.some((word) => Array.from(word).length > REVIEW_LIMITS.blockWordLength)) return { ok: false, error: "blockWordTooLong" };
  return {
    ok: true,
    body: {
      enabled: form.enabled,
      moderation: form.moderation,
      requestsEnabled: form.requestsEnabled,
      requestDelayDays: delay,
      blockWords,
      expectedRevision,
    },
  };
}

export function useSaveReviewSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ReviewSettingsBody) => apiData(putApiV1AdminReviewsSettings({ body })),
    onSuccess: (settings) => queryClient.setQueryData(reviewKeys.settings(), settings),
    onError: (error) => {
      if (isConflict(error)) void queryClient.invalidateQueries({ queryKey: reviewKeys.settings() });
    },
  });
}

const PRODUCT_PAGE_SIZE = 20;

/** Server-searched products for the product filter (the search stays in the request, never the URL). */
export const reviewProductLoader: SearchableSelectLoader = async ({ search, page }) => {
  const result = await fetchProducts({ page, limit: PRODUCT_PAGE_SIZE, ...(search ? { search } : {}) });
  return {
    options: result.products.map((product) => ({ value: product.id, label: product.name })),
    hasMore: page < result.pagination.totalPages,
  };
};
