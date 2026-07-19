import { queryOptions } from "@tanstack/react-query";
import {
  getAbandonedCheckouts,
  type AbandonedCheckoutsQueryInput,
} from "../api-functions/abandoned-checkouts";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const abandonedCheckoutsQueryOptions = (
  params: AbandonedCheckoutsQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.abandonedCheckouts.list(params),
    queryFn: () => getAbandonedCheckouts({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });
