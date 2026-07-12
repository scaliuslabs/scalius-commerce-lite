import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getCollection,
  getCollectionCategoryOptions,
  getCollectionFormOptions,
  getCollectionProductOptions,
  getCollections,
  getCollectionsByIds,
  type CollectionsByIdsPayload,
  type CollectionCategoryOptionsPayload,
  type CollectionFormOptionsPayload,
  type CollectionsQueryInput,
  type CollectionProductOptionsInput,
} from "../api-functions/collections";
import { queryKeys } from "../query-keys";
import { normalizeCollectionProductOptionsPayload } from "../collection-product-options";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;
const EMPTY_COLLECTIONS_BY_IDS: CollectionsByIdsPayload = { collections: [] };
const EMPTY_COLLECTION_FORM_OPTIONS: CollectionFormOptionsPayload = {
  categories: [],
  products: [],
};
const EMPTY_COLLECTION_CATEGORY_OPTIONS: CollectionCategoryOptionsPayload = {
  categories: [],
};

function normalizeLookupIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

function normalizeCollectionsByIdsPayload(payload: unknown): CollectionsByIdsPayload {
  const collections = (payload as Partial<CollectionsByIdsPayload> | null | undefined)
    ?.collections;
  return { collections: Array.isArray(collections) ? collections : [] };
}

function normalizeCollectionFormOptionsPayload(
  payload: unknown,
): CollectionFormOptionsPayload {
  const options = payload as Partial<CollectionFormOptionsPayload> | null | undefined;
  return {
    categories: Array.isArray(options?.categories) ? options.categories : [],
    products: Array.isArray(options?.products) ? options.products : [],
  };
}

function normalizeCollectionCategoryOptionsPayload(
  payload: unknown,
): CollectionCategoryOptionsPayload {
  const categories = (
    payload as Partial<CollectionCategoryOptionsPayload> | null | undefined
  )?.categories;
  return { categories: Array.isArray(categories) ? categories : [] };
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
        ? Promise.resolve(EMPTY_COLLECTIONS_BY_IDS)
        : getCollectionsByIds({ data: { ids: normalizedIds } }).then(
            normalizeCollectionsByIdsPayload,
          ),
    placeholderData: EMPTY_COLLECTIONS_BY_IDS,
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
    queryFn: () =>
      getCollectionFormOptions().then(normalizeCollectionFormOptionsPayload),
    placeholderData: EMPTY_COLLECTION_FORM_OPTIONS,
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const collectionCategoryOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.collections.categoryOptions(),
    queryFn: () =>
      getCollectionCategoryOptions().then(
        normalizeCollectionCategoryOptionsPayload,
      ),
    placeholderData: EMPTY_COLLECTION_CATEGORY_OPTIONS,
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const collectionProductOptionsQueryOptions = (
  input: Omit<CollectionProductOptionsInput, "page">,
) => {
  const categoryIds = normalizeLookupIds(input.categoryIds ?? []).slice(0, 90);
  const search = input.search?.trim() ?? "";
  const limit = input.limit ?? 10;

  return infiniteQueryOptions({
    queryKey: queryKeys.products.collectionOptions({
      categoryIds,
      search,
      limit,
    }),
    queryFn: ({ pageParam }) =>
      getCollectionProductOptions({
        data: { page: pageParam, limit, search, categoryIds },
      }).then((payload) =>
        normalizeCollectionProductOptionsPayload(payload, {
          page: pageParam,
          limit,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    staleTime: MODERATE_STALE_TIME_MS,
  });
};
