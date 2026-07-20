import { queryOptions } from "@tanstack/react-query";

import {
  getPromotion,
  getPromotions,
  type PromotionsQueryInput,
} from "../api-functions/promotions";
import { queryKeys } from "../query-keys";

const PROMOTIONS_LIST_STALE_TIME_MS = 30_000;

export const promotionsQueryOptions = (params: PromotionsQueryInput = {}) =>
  queryOptions({
    queryKey: queryKeys.promotions.list(params),
    queryFn: () => getPromotions({ data: params }),
    staleTime: PROMOTIONS_LIST_STALE_TIME_MS,
  });

export const promotionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.promotions.detail(id),
    queryFn: () => getPromotion({ data: { id } }),
    staleTime: 0,
  });

// Domain-language aliases used by route loaders and editor screens.
export const promotionListQueryOptions = promotionsQueryOptions;
export const promotionDetailQueryOptions = promotionQueryOptions;
