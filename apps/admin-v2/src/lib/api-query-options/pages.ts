import { queryOptions } from "@tanstack/react-query";
import { getPage, getPages, type PagesQueryInput } from "../api-functions/pages";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const pagesQueryOptions = (params: PagesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.pages.list(params),
    queryFn: () => getPages({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const pageQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.pages.detail(id),
    queryFn: () => getPage({ data: { id } }),
    staleTime: 0,
  });
