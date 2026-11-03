import { STOREFRONT_ROUTE_SEGMENTS } from "@scalius/shared/storefront-route-segments";
import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";

export type ContentType = "page" | "article";

/** The list's session search key (list-search.ts). */
export const contentListName = (type: ContentType) => (type === "article" ? "articles" : "pages");

/**
 * A page saved before the store claimed its address: the store's own page answers there, so visitors never
 * reach the page. Blog posts live under `/blog/` and never collide.
 */
export function pageIsShadowedByStoreRoute(type: ContentType, slug: string): boolean {
  return type === "page" && STOREFRONT_ROUTE_SEGMENTS.has(slug);
}

export const PAGE_STATUS_FILTERS = ["draft", "scheduled", "published"] as const;
export type PageStatusFilter = (typeof PAGE_STATUS_FILTERS)[number];

const validateBasePageSearch = createListSearchValidator(
  ["title", "createdAt", "updatedAt"] as const,
  { sort: "updatedAt", list: "content" },
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
