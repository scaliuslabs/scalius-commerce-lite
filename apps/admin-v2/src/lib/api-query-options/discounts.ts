import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminDiscounts,
  getApiV1AdminDiscountsById,
  type postApiV1AdminDiscounts,
  type putApiV1AdminDiscountsById,
} from "@scalius/api-client/sdk";

import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

export type DiscountRecord = ApiResult<typeof getApiV1AdminDiscountsById>;
export type DiscountInput = ApiBody<typeof postApiV1AdminDiscounts>;
export type DiscountUpdateInput = ApiBody<typeof putApiV1AdminDiscountsById>;

/** Every discount (code and automatic) in one list, newest edits first. */
export const discountsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.discounts.list(),
    queryFn: async () => (await apiData(getApiV1AdminDiscounts({ query: {} }))).discounts,
    staleTime: 30_000,
  });

export const discountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.discounts.detail(id),
    queryFn: () => apiData(getApiV1AdminDiscountsById({ path: { id } })),
    staleTime: 0,
  });
