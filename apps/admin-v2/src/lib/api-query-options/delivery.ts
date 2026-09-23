import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminSettingsDeliveryLocations,
  getApiV1AdminSettingsDeliveryLocationsImportPathaoStatus,
  getApiV1AdminSettingsDeliveryProviders,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult, type WithTimestamps } from "../api";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

type ApiDeliveryProvider =
  ApiResult<typeof getApiV1AdminSettingsDeliveryProviders>["providers"][number];
export type DeliveryProviderRecord = Omit<ApiDeliveryProvider, "readiness"> & {
  readiness?: WithTimestamps<
    NonNullable<ApiDeliveryProvider["readiness"]>,
    "lastTestAttemptAt" | "lastTestSuccessAt" | "lastTestFailureAt"
  >;
};
export type DeliveryLocationsQuery = ApiQuery<typeof getApiV1AdminSettingsDeliveryLocations>;
export type DeliveryLocation =
  ApiResult<typeof getApiV1AdminSettingsDeliveryLocations>["locations"][number];
export type PathaoImportProgress =
  ApiResult<typeof getApiV1AdminSettingsDeliveryLocationsImportPathaoStatus>;

async function getAllDeliveryProviders(): Promise<DeliveryProviderRecord[]> {
  const providers: DeliveryProviderRecord[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await apiData(getApiV1AdminSettingsDeliveryProviders({
      query: { page, limit: 10 },
    }));
    providers.push(...(result.providers as DeliveryProviderRecord[]));
    if (!result.pagination.hasMore) return providers;
  }
  throw new Error("Delivery provider list exceeded the supported page limit");
}

export const getDeliveryLocations = (query: DeliveryLocationsQuery) =>
  apiData(getApiV1AdminSettingsDeliveryLocations({ query }));

async function getAllDeliveryLocations(type?: DeliveryLocationsQuery["type"]) {
  const firstPage = await getDeliveryLocations({ type, limit: 500, page: 1 });
  const locations = [...firstPage.locations];
  for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
    const nextPage = await getDeliveryLocations({ type, limit: 500, page });
    locations.push(...nextPage.locations);
  }
  return { locations, pagination: firstPage.pagination };
}

export const deliveryProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryProviders(),
    queryFn: getAllDeliveryProviders,
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const deliveryLocationsQueryOptions = (query: DeliveryLocationsQuery) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocations(query),
    queryFn: () => getDeliveryLocations(query),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const allDeliveryLocationsQueryOptions = (params: {
  type?: DeliveryLocationsQuery["type"];
}) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocationsAll(params),
    queryFn: () => getAllDeliveryLocations(params.type),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const importPathaoStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.importPathaoStatus(),
    queryFn: () => apiData(getApiV1AdminSettingsDeliveryLocationsImportPathaoStatus()),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
