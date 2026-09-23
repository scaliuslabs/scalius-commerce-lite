import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminPromotions,
  getApiV1AdminPromotionsById,
  type postApiV1AdminPromotions,
  type putApiV1AdminPromotionsById,
} from "@scalius/api-client/sdk";

import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const PROMOTIONS_LIST_STALE_TIME_MS = 30_000;

export type PromotionAggregate = ApiResult<typeof getApiV1AdminPromotionsById>;
export type CreatePromotionDraftInput = ApiBody<typeof postApiV1AdminPromotions>;
export type UpdatePromotionDraftInput = ApiBody<typeof putApiV1AdminPromotionsById>;

export const promotionsQueryOptions = (
  params: { limit?: number; includeDeleted?: boolean } = {},
) =>
  queryOptions({
    queryKey: queryKeys.promotions.list(params),
    queryFn: async () => (await apiData(getApiV1AdminPromotions({
      query: {
        limit: params.limit,
        includeDeleted: params.includeDeleted ? "true" : undefined,
      },
    }))).promotions,
    staleTime: PROMOTIONS_LIST_STALE_TIME_MS,
  });

export const promotionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.promotions.detail(id),
    queryFn: () => apiData(getApiV1AdminPromotionsById({ path: { id } })),
    staleTime: 0,
  });

// Domain-language aliases used by route loaders and editor screens.
export const promotionListQueryOptions = promotionsQueryOptions;
export const promotionDetailQueryOptions = promotionQueryOptions;
