import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminFraudChecker,
  type postApiV1AdminFraudCheckerLookup,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export type FraudCheckerProvider = ApiResult<typeof getApiV1AdminFraudChecker>["providers"][number];
export type FraudLookupData = ApiResult<typeof postApiV1AdminFraudCheckerLookup>;

async function getAllFraudCheckerProviders(): Promise<FraudCheckerProvider[]> {
  const providers: FraudCheckerProvider[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await apiData(getApiV1AdminFraudChecker({ query: { page, limit: 20 } }));
    providers.push(...result.providers);
    if (!result.pagination.hasMore) return providers;
  }
  throw new Error("Fraud provider list exceeded the supported page limit");
}

export const fraudCheckerProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.fraudChecker.list(),
    queryFn: getAllFraudCheckerProviders,
    staleTime: LOOKUP_STALE_TIME_MS,
  });
