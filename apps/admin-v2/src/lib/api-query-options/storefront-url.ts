import { queryOptions } from "@tanstack/react-query";
import { getStorefrontUrl } from "../api-functions/storefront-url";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const storefrontUrlQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storefrontUrl(),
    queryFn: () => getStorefrontUrl(),
    staleTime: CONFIG_STALE_TIME_MS,
  });
