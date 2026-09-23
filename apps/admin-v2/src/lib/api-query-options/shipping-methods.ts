import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminSettingsShippingMethods } from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

type ShippingMethodsPayload = ApiResult<typeof getApiV1AdminSettingsShippingMethods>;
export type ShippingMethod = ShippingMethodsPayload["shippingMethods"][number];
export type ShippingMethodsPagination = ShippingMethodsPayload["pagination"];
export type ShippingMethodsQuery = ApiQuery<typeof getApiV1AdminSettingsShippingMethods>;

export const shippingMethodsQueryOptions = (query: ShippingMethodsQuery) =>
  queryOptions({
    queryKey: queryKeys.settings.shippingMethods(query),
    queryFn: () => apiData(getApiV1AdminSettingsShippingMethods({ query })),
    staleTime: CONFIG_STALE_TIME_MS,
  });
