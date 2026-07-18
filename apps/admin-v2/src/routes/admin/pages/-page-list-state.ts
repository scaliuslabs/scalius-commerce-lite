import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";

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

export function pageListQueryParams(deps: ReturnType<typeof validatePageSearch>) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
    status: deps.trashed ? undefined : deps.status,
  };
}
