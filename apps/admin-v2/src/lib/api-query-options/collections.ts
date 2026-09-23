import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminCollections,
  getApiV1AdminCollectionsById,
  getApiV1AdminCollectionsByIds,
  getApiV1AdminCollectionsCategoryOptions,
  getApiV1AdminCollectionsFormOptions,
  getApiV1AdminCollectionsProductOptions,
  type postApiV1AdminCollections,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
import { normalizeCollectionProductOptionsPayload } from "../collection-product-options";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export type CollectionSummaryDto = ApiResult<typeof getApiV1AdminCollections>["collections"][number];
export type CollectionDto = ApiResult<typeof getApiV1AdminCollectionsById>;
export type CollectionPresentation = CollectionDto["presentation"];
export type CreateCollectionInput = ApiBody<typeof postApiV1AdminCollections>;
export type CollectionsByIdsPayload = ApiResult<typeof getApiV1AdminCollectionsByIds>;
export type CollectionFormOptionsPayload = ApiResult<typeof getApiV1AdminCollectionsFormOptions>;
export type CollectionCategoryOptionsPayload =
  ApiResult<typeof getApiV1AdminCollectionsCategoryOptions>;
export type CollectionProductOptionsPayload =
  ApiResult<typeof getApiV1AdminCollectionsProductOptions>;
export type CollectionProductOptionDto = CollectionProductOptionsPayload["products"][number];

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

export const collectionsQueryOptions = (query: ApiQuery<typeof getApiV1AdminCollections>) =>
  queryOptions({
    queryKey: queryKeys.collections.list(query),
    queryFn: () => apiData(getApiV1AdminCollections({ query })),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const collectionPickerOptionsQueryOptions = ({
  search: rawSearch = "",
  limit: rawLimit = 10,
}: {
  search?: string;
  limit?: number;
}) => {
  const search = rawSearch.trim();
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));

  return infiniteQueryOptions({
    queryKey: queryKeys.collections.list({
      scope: "discount-picker",
      search,
      limit,
    }),
    queryFn: ({ pageParam }) =>
      apiData(getApiV1AdminCollections({
        query: { page: pageParam, limit, search: search || undefined },
      })),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    staleTime: MODERATE_STALE_TIME_MS,
  });
};

export const collectionsByIdsQueryOptions = (ids: readonly string[]) => {
  const normalizedIds = normalizeLookupIds(ids);
  return queryOptions({
    queryKey: queryKeys.collections.byIds(normalizedIds),
    queryFn: () =>
      normalizedIds.length === 0
        ? Promise.resolve(EMPTY_COLLECTIONS_BY_IDS)
        : apiData(getApiV1AdminCollectionsByIds({ query: { ids: normalizedIds.join(",") } })),
    placeholderData: EMPTY_COLLECTIONS_BY_IDS,
    staleTime: LOOKUP_STALE_TIME_MS,
  });
};

export const collectionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.collections.detail(id),
    queryFn: () => apiData(getApiV1AdminCollectionsById({ path: { id } })),
    staleTime: 0,
  });

export const collectionFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.collections.formOptions(),
    queryFn: () => apiData(getApiV1AdminCollectionsFormOptions()),
    placeholderData: EMPTY_COLLECTION_FORM_OPTIONS,
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const collectionCategoryOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.collections.categoryOptions(),
    queryFn: () => apiData(getApiV1AdminCollectionsCategoryOptions()),
    placeholderData: EMPTY_COLLECTION_CATEGORY_OPTIONS,
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const collectionProductOptionsQueryOptions = (input: {
  limit?: number;
  search?: string;
  categoryIds?: string[];
  selectedProductIds?: string[];
}) => {
  const categoryIds = normalizeLookupIds(input.categoryIds ?? []).slice(0, 90);
  const selectedProductIds = normalizeLookupIds(input.selectedProductIds ?? [])
    .slice(0, 90)
    .sort();
  const search = input.search?.trim() ?? "";
  const limit = input.limit ?? 10;

  return infiniteQueryOptions({
    queryKey: queryKeys.products.collectionOptions({
      categoryIds,
      selectedProductIds,
      search,
      limit,
    }),
    queryFn: ({ pageParam }) =>
      apiData(getApiV1AdminCollectionsProductOptions({
        query: {
          page: pageParam,
          limit,
          search: search || undefined,
          categoryIds: categoryIds.length > 0 ? categoryIds.join(",") : undefined,
          selectedProductIds: selectedProductIds.length > 0
            ? selectedProductIds.join(",")
            : undefined,
        },
      })).then((payload) =>
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
