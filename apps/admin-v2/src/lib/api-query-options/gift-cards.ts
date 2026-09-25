import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminGiftCards,
  getApiV1AdminGiftCardsByGiftCardId,
  getApiV1AdminGiftCardsSummary,
} from "@scalius/api-client/sdk";

import { apiData, type ApiQuery, type ApiResult } from "../api";

export type GiftCardListPayload = ApiResult<typeof getApiV1AdminGiftCards>;
export type GiftCardSummary = GiftCardListPayload["items"][number];
export type GiftCardDetailPayload = ApiResult<typeof getApiV1AdminGiftCardsByGiftCardId>;
export type GiftCardDetail = GiftCardDetailPayload["giftCard"];
export type GiftCardTransaction = GiftCardDetailPayload["transactions"][number];
export type GiftCardOutstanding = ApiResult<typeof getApiV1AdminGiftCardsSummary>["outstanding"][number];
export type GiftCardListQuery = ApiQuery<typeof getApiV1AdminGiftCards>;
export type GiftCardListFilter = NonNullable<GiftCardListQuery["status"]>;

/**
 * Gift-card query keys. They hold last 4, balances and masked contacts only:
 * a card's code is never read back after the one-time reveal, so nothing
 * here (or in any cache) carries it.
 */
export const giftCardKeys = {
  all: ["gift-cards"] as const,
  lists: () => ["gift-cards", "list"] as const,
  list: (query: GiftCardListQuery) => ["gift-cards", "list", query] as const,
  summary: () => ["gift-cards", "summary"] as const,
  detail: (id: string) => ["gift-cards", "detail", id] as const,
};

export const GIFT_CARD_PAGE_SIZE = 25;

/** One keyset page, newest first. `q` is sent to the API only, never put in the page URL. */
export const giftCardsQueryOptions = (query: GiftCardListQuery) =>
  queryOptions({
    queryKey: giftCardKeys.list(query),
    queryFn: () => apiData(getApiV1AdminGiftCards({ query })),
    staleTime: 30_000,
  });

/** Outstanding liability per currency (active, unexpired cards with a balance). */
export const giftCardSummaryQueryOptions = () =>
  queryOptions({
    queryKey: giftCardKeys.summary(),
    queryFn: () => apiData(getApiV1AdminGiftCardsSummary()),
    staleTime: 30_000,
  });

export const giftCardQueryOptions = (id: string) =>
  queryOptions({
    queryKey: giftCardKeys.detail(id),
    queryFn: () => apiData(getApiV1AdminGiftCardsByGiftCardId({ path: { giftCardId: id } })),
    staleTime: 0,
  });
