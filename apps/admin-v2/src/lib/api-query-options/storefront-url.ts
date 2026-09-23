import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminSettingsStorefrontUrl } from "@scalius/api-client/sdk";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const storefrontUrlQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storefrontUrl(),
    queryFn: () => apiData(getApiV1AdminSettingsStorefrontUrl()),
    staleTime: CONFIG_STALE_TIME_MS,
  });
