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

export type DiscountListQuery = NonNullable<Parameters<typeof getApiV1AdminDiscounts>[0]>["query"];
export type DiscountListItem = ApiResult<typeof getApiV1AdminDiscounts>["discounts"][number];

/**
 * One page of discounts, searched, filtered and sorted on the server: each
 * row has its first code only (`codeCount` says how many more).
 */
export const discountsQueryOptions = (query: DiscountListQuery = {}) =>
  queryOptions({
    queryKey: queryKeys.discounts.list(query as Record<string, unknown>),
    queryFn: () => apiData(getApiV1AdminDiscounts({ query })),
    staleTime: 30_000,
  });

export const discountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.discounts.detail(id),
    queryFn: () => apiData(getApiV1AdminDiscountsById({ path: { id } })),
    staleTime: 0,
  });
