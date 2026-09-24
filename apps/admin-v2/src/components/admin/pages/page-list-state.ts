import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { readListSearch } from "~/lib/list-search";
import { pagesQueryOptions } from "~/lib/api-query-options/pages";

export type ContentType = "page" | "article";

/** The list's session search key (list-search.ts). */
export const contentListName = (type: ContentType) => (type === "article" ? "articles" : "pages");

export const PAGE_STATUS_FILTERS = ["draft", "scheduled", "published"] as const;
export type PageStatusFilter = (typeof PAGE_STATUS_FILTERS)[number];

const validateBasePageSearch = createListSearchValidator(
  ["title", "createdAt", "updatedAt"] as const,
  { sort: "updatedAt" },
);

export function validatePageSearch(search: SearchValidatorInput) {
  return {
    ...validateBasePageSearch(search),
    status: normalizeOptionalEnumSearchParam(search.status, PAGE_STATUS_FILTERS),
  };
}

export function pageListQueryParams(deps: ReturnType<typeof validatePageSearch>, term: string) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: term || undefined,
    sort: deps.sort,
    order: deps.order,
    trashed: deps.trashed ? ("true" as const) : undefined,
    status: deps.trashed ? undefined : deps.status,
  };
}

export function contentListQuery(
  type: ContentType,
  search: ReturnType<typeof validatePageSearch>,
  term = readListSearch(contentListName(type)),
) {
  return pagesQueryOptions({ ...pageListQueryParams(search, term), contentType: type === "article" ? "article" : undefined });
}
