import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminSettingsDeliveryLocations,
  getApiV1AdminSettingsDeliveryProviders,
} from "@scalius/api-client/sdk";
import {
  PLACE_ADDRESS_COUNTRY,
  deliveryHierarchyLevel,
  type DeliveryHierarchyField,
} from "@scalius/shared/places";
import { apiData, type ApiQuery, type ApiResult, type WithTimestamps } from "../api";
import { queryKeys } from "../query-keys";
import type { SearchableSelectLoader, SearchableSelectOption } from "~/components/ui/searchable-select";

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

export const getDeliveryLocations = (query: DeliveryLocationsQuery, signal?: AbortSignal) =>
  apiData(getApiV1AdminSettingsDeliveryLocations({ query, signal }));

/** Places a picker offers per page. */
export const LOCATION_PAGE_SIZE = 50;

/** The list filter for one Bangladesh address field (city, thana or area). */
export const addressPlaceQuery = (field: DeliveryHierarchyField) =>
  ({ country: PLACE_ADDRESS_COUNTRY, level: deliveryHierarchyLevel(field) });

/** A place as a combobox option: its parents ("Mirpur · Dhaka") as the secondary text. */
export function locationOption(location: Pick<DeliveryLocation, "id" | "name" | "parentPath">): SearchableSelectOption {
  const path = location.parentPath?.join(" · ");
  return { value: location.id, label: location.name, ...(path ? { description: path } : {}) };
}

/**
 * Server-searched, paged places for a picker: one Bangladesh address field
 * (`type`) or one country's level, optionally under one parent, active only
 * unless asked. The search goes in the API request, never in the page URL.
 */
export function deliveryLocationLoader(filter: {
  type?: DeliveryHierarchyField;
  country?: string;
  level?: number;
  parentId?: string;
  includeInactive?: boolean;
  /** Turns each place into an option (defaults to `locationOption`). */
  toOption?: (location: DeliveryLocation) => SearchableSelectOption;
}): SearchableSelectLoader {
  return async ({ search, page, signal }) => {
    const result = await getDeliveryLocations({
      ...(filter.type ? addressPlaceQuery(filter.type) : {}),
      ...(filter.country ? { country: filter.country } : {}),
      ...(filter.level ? { level: filter.level } : {}),
      ...(filter.parentId ? { parentId: filter.parentId } : {}),
      ...(filter.includeInactive ? {} : { isActive: "true" as const }),
      ...(search ? { search } : {}),
      page,
      limit: LOCATION_PAGE_SIZE,
    }, signal);
    return {
      options: result.locations.map(filter.toOption ?? locationOption),
      hasMore: page < result.pagination.totalPages,
    };
  };
}

/** One place by ID, to label a saved choice whose name was not stored. */
export const deliveryLocationByIdQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...queryKeys.settings.deliveryLocations(), "by-id", id],
    queryFn: async () => (await getDeliveryLocations({ id, limit: 1 })).locations[0] ?? null,
    staleTime: LOOKUP_STALE_TIME_MS,
  });

async function getAllDeliveryLocations(type?: DeliveryHierarchyField) {
  const filter = type ? addressPlaceQuery(type) : {};
  const firstPage = await getDeliveryLocations({ ...filter, limit: 500, page: 1 });
  const locations = [...firstPage.locations];
  for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
    const nextPage = await getDeliveryLocations({ ...filter, limit: 500, page });
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
  type?: DeliveryHierarchyField;
}) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocationsAll(params),
    queryFn: () => getAllDeliveryLocations(params.type),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
