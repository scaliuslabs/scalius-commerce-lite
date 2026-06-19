import { queryOptions } from "@tanstack/react-query";
import { getCurrencySettings } from "../api-functions/currency";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const currencySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.currency(),
    queryFn: () => getCurrencySettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });
