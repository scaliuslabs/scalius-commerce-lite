import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminAbandonedCheckouts, getApiV1AdminAbandonedCheckoutsById } from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export type AbandonedCheckout = ApiResult<typeof getApiV1AdminAbandonedCheckouts>["checkouts"][number];

export const abandonedCheckoutsQueryOptions = (
  query: ApiQuery<typeof getApiV1AdminAbandonedCheckouts>,
) =>
  queryOptions({
    queryKey: queryKeys.abandonedCheckouts.list(query),
    queryFn: () => apiData(getApiV1AdminAbandonedCheckouts({ query })),
    staleTime: MODERATE_STALE_TIME_MS,
  });

/** One checkout, for a link to a checkout the list's loaded page doesn't hold. A missing one is not retried. */
export const abandonedCheckoutQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...queryKeys.abandonedCheckouts.all, "detail", id] as const,
    queryFn: async (): Promise<AbandonedCheckout> =>
      (await apiData(getApiV1AdminAbandonedCheckoutsById({ path: { id } }))).checkout,
    staleTime: MODERATE_STALE_TIME_MS,
    retry: false,
  });
