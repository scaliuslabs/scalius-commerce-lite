import { queryOptions } from "@tanstack/react-query";
import { getFraudCheckerProviders } from "../api-functions/fraud-checker";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export const fraudCheckerProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.fraudChecker.list(),
    queryFn: () => getFraudCheckerProviders(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
