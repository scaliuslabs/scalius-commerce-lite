import { queryOptions } from "@tanstack/react-query";
import {
  getAllDeliveryLocations,
  getDeliveryLocations,
  getDeliveryProviders,
  getImportPathaoStatus,
  type DeliveryLocationsQueryInput,
} from "../api-functions/delivery";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export const deliveryProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryProviders(),
    queryFn: () => getDeliveryProviders(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const deliveryLocationsQueryOptions = (
  params: DeliveryLocationsQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocations(params),
    queryFn: () => getDeliveryLocations({ data: params }),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const allDeliveryLocationsQueryOptions = (params: { type?: string }) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocationsAll(params),
    queryFn: () => getAllDeliveryLocations({ data: params }),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const importPathaoStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.importPathaoStatus(),
    queryFn: () => getImportPathaoStatus(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
