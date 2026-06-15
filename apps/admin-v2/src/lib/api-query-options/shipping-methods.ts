import { queryOptions } from "@tanstack/react-query";
import {
  getShippingMethods,
  type ShippingMethodsQueryInput,
} from "../api-functions/shipping-methods";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const shippingMethodsQueryOptions = (
  params: ShippingMethodsQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.settings.shippingMethods(params),
    queryFn: () => getShippingMethods({ data: params }),
    staleTime: CONFIG_STALE_TIME_MS,
  });
