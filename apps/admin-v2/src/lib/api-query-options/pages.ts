import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminPages,
  getApiV1AdminPagesById,
  type postApiV1AdminPages,
  type putApiV1AdminPagesById,
} from "@scalius/api-client/sdk";
import {
  contentListName,
  pageListQueryParams,
  type ContentType,
  type validatePageSearch,
} from "~/components/admin/pages/page-list-state";
import { apiData, type ApiBody, type ApiQuery, type ApiResult } from "../api";
import { readListSearch } from "../list-search";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export type PageDto = ApiResult<typeof getApiV1AdminPagesById>["page"];
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
    queryFn: async () => (await apiData(getApiV1AdminPagesById({ path: { id } }))).page,
    staleTime: 0,
  });

/** The Pages or Blog posts list's read (the list's session search, never the page URL). */
export function contentListQuery(
  type: ContentType,
  search: ReturnType<typeof validatePageSearch>,
  term = readListSearch(contentListName(type)),
) {
  return pagesQueryOptions({ ...pageListQueryParams(search, term), contentType: type === "article" ? "article" : undefined });
}
