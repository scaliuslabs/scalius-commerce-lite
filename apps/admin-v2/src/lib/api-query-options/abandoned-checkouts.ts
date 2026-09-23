import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminAbandonedCheckouts } from "@scalius/api-client/sdk";
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
