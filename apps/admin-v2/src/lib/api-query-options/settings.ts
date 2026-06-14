import { queryOptions } from "@tanstack/react-query";
import {
  getAuthSettings,
  getCurrencySettings,
  getStorefrontUrl,
} from "../api-functions/settings";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const storefrontUrlQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storefrontUrl(),
    queryFn: () => getStorefrontUrl(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const currencySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.currency(),
    queryFn: () => getCurrencySettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const authSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.auth(),
    queryFn: () => getAuthSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });
