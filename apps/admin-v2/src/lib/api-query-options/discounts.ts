import { queryOptions } from "@tanstack/react-query";
import {
  getDiscount,
  getDiscounts,
  type DiscountsQueryInput,
} from "../api-functions/discounts";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const discountsQueryOptions = (params: DiscountsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.discounts.list(params),
    queryFn: () => getDiscounts({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const discountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.discounts.detail(id),
    queryFn: () => getDiscount({ data: { id } }),
    staleTime: 0,
  });
