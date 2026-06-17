import { queryOptions } from "@tanstack/react-query";
import {
  getCategories,
  getCategory,
  getCategoryFormOptions,
  type CategoriesQueryInput,
} from "../api-functions/categories";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export const categoriesQueryOptions = (params: CategoriesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.categories.list(params),
    queryFn: () => getCategories({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const categoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.categories.detail(id),
    queryFn: () => getCategory({ data: { id } }),
    staleTime: 0,
  });

export const categoryFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.categories.formOptions(),
    queryFn: () => getCategoryFormOptions(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
