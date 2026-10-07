import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import {
  getApiV1AdminSettingsStoreDefaults,
  getApiV1AdminSettingsStoreSetup,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
import { setStoreRegion, setStoreTimeZone } from "../store-time-zone";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export type StoreDefaultsPayload = ApiResult<typeof getApiV1AdminSettingsStoreDefaults>;
export type StoreSetupStatus = ApiResult<typeof getApiV1AdminSettingsStoreSetup>;

/** The store's time zone and units: every staff screen formats with them. */
export const storeDefaultsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storeDefaults(),
    queryFn: () => apiData(getApiV1AdminSettingsStoreDefaults()),
    staleTime: CONFIG_STALE_TIME_MS,
  });

/** Whether the new-store setup step still applies, and what the store has now. */
export const storeSetupQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storeSetup(),
    queryFn: () => apiData(getApiV1AdminSettingsStoreSetup()),
  });

/**
 * Sets the dashboard's store time zone and country from the settings (the
 * admin frame's loader runs it on each navigation; the read is cached for 30
 * minutes). Until it returns, the last known values hold.
 */
export async function syncStoreDefaults(queryClient: QueryClient): Promise<void> {
  const defaults = await queryClient.fetchQuery(storeDefaultsQueryOptions());
  setStoreTimeZone(defaults.timeZone);
  setStoreRegion(defaults.countryCode);
}

/** The store's unit system and default weight unit (metric grams until the read returns). */
export function useStoreUnits(): Pick<StoreDefaultsPayload, "unitSystem" | "weightUnit"> {
  const { data } = useQuery(storeDefaultsQueryOptions());
  return { unitSystem: data?.unitSystem ?? "metric", weightUnit: data?.weightUnit ?? "g" };
}
