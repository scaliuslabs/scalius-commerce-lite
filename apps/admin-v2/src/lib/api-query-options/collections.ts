import { queryOptions } from "@tanstack/react-query";
import {
  getCollections,
  type CollectionsQueryInput,
} from "../api-functions/collections";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const collectionsQueryOptions = (params: CollectionsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.collections.list(params),
    queryFn: () => getCollections({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });
