import { queryOptions } from "@tanstack/react-query";
import {
  getCollection,
  getCollectionCategoryOptions,
  getCollectionFormOptions,
  getCollections,
  getCollectionsByIds,
  type CollectionsQueryInput,
} from "../api-functions/collections";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

function normalizeLookupIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

export const collectionsQueryOptions = (params: CollectionsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.collections.list(params),
    queryFn: () => getCollections({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const collectionsByIdsQueryOptions = (ids: readonly string[]) => {
  const normalizedIds = normalizeLookupIds(ids);
  return queryOptions({
    queryKey: queryKeys.collections.byIds(normalizedIds),
    queryFn: () =>
      normalizedIds.length === 0
        ? Promise.resolve({ collections: [] })
        : getCollectionsByIds({ data: { ids: normalizedIds } }),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
};

export const collectionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.collections.detail(id),
    queryFn: () => getCollection({ data: { id } }),
    staleTime: 0,
  });

export const collectionFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.collections.formOptions(),
    queryFn: () => getCollectionFormOptions(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const collectionCategoryOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.collections.categoryOptions(),
    queryFn: () => getCollectionCategoryOptions(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
