import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminPages,
  getApiV1AdminPagesById,
  type postApiV1AdminPages,
  type putApiV1AdminPagesById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export type PageDto = ApiResult<typeof getApiV1AdminPagesById>;
export type PageListItem = ApiResult<typeof getApiV1AdminPages>["pages"][number];
export type CreatePageInput = ApiBody<typeof postApiV1AdminPages>;
export type UpdatePageInput = ApiBody<typeof putApiV1AdminPagesById>;
export type PageRevisionClaim = { id: string; expectedRevision: number };

export const pagesQueryOptions = (query: ApiQuery<typeof getApiV1AdminPages>) =>
  queryOptions({
    queryKey: queryKeys.pages.list(query),
    queryFn: () => apiData(getApiV1AdminPages({ query })),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const pageQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.pages.detail(id),
    queryFn: () => apiData(getApiV1AdminPagesById({ path: { id } })),
    staleTime: 0,
  });
