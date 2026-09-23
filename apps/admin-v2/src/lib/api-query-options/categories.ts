import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminCategories,
  getApiV1AdminCategoriesById,
  getApiV1AdminCategoriesFormOptions,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export type CategoriesQuery = ApiQuery<typeof getApiV1AdminCategories>;
export type CategoryListItem = ApiResult<typeof getApiV1AdminCategories>["categories"][number];
export type CategoryDetail = ApiResult<typeof getApiV1AdminCategoriesById>;
export type CategoryRevisionClaim = { id: string; expectedRevision: number };

export const categoriesQueryOptions = (query: CategoriesQuery) =>
  queryOptions({
    queryKey: queryKeys.categories.list(query),
    queryFn: () => apiData(getApiV1AdminCategories({ query })),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const categoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.categories.detail(id),
    queryFn: () => apiData(getApiV1AdminCategoriesById({ path: { id } })),
    staleTime: 0,
  });

export const categoryFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.categories.formOptions(),
    queryFn: () => apiData(getApiV1AdminCategoriesFormOptions()),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
