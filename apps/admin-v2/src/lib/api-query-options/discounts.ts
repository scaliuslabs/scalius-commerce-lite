import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminDiscounts,
  getApiV1AdminDiscountsById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export type DiscountsQuery = ApiQuery<typeof getApiV1AdminDiscounts>;

/**
 * Contract gap: `discountSchema` in apps/api/src/schemas/entities.ts omits
 * fields the discount service returns. Remove once the API schema lists them.
 */
type DiscountServiceFields = {
  combineWithProductDiscounts: boolean;
  combineWithOrderDiscounts: boolean;
  combineWithShippingDiscounts: boolean;
  relatedProducts: { buy: string[]; get: string[] };
  relatedCollections: { buy: string[]; get: string[] };
};
export type DiscountDto = ApiResult<typeof getApiV1AdminDiscountsById> & DiscountServiceFields;
export type DiscountListItem =
  ApiResult<typeof getApiV1AdminDiscounts>["discounts"][number] &
  DiscountServiceFields & { usageCount?: number; totalDiscountAmount?: number };
export const DISCOUNT_TYPES = [
  "amount_off_products",
  "amount_off_order",
  "free_shipping",
] as const satisfies readonly NonNullable<DiscountsQuery["type"]>[];

export const discountsQueryOptions = (query: DiscountsQuery) =>
  queryOptions({
    queryKey: queryKeys.discounts.list(query),
    queryFn: async () => {
      const result = await apiData(getApiV1AdminDiscounts({ query }));
      return result as Omit<typeof result, "discounts"> & { discounts: DiscountListItem[] };
    },
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const discountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.discounts.detail(id),
    queryFn: async () =>
      (await apiData(getApiV1AdminDiscountsById({ path: { id } }))) as DiscountDto,
    staleTime: 0,
  });
