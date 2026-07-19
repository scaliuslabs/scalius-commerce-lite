import {
  normalizeEnumSearchParam,
  normalizeListPositiveInteger,
  normalizeSearchString,
} from "./list-helpers";

export const ABANDONED_CHECKOUT_SORTS = [
  "checkoutId",
  "customerPhone",
  "updatedAt",
] as const;

export type AbandonedCheckoutSort = (typeof ABANDONED_CHECKOUT_SORTS)[number];

export interface AbandonedCheckoutRouteState {
  page: number;
  limit: number;
  search: string;
  sort: AbandonedCheckoutSort;
  order: "asc" | "desc";
}

export function validateAbandonedCheckoutSearch(
  search: Record<string, unknown>,
): AbandonedCheckoutRouteState {
  return {
    page: normalizeListPositiveInteger(search.page, 1),
    limit: normalizeListPositiveInteger(search.limit, 20, { max: 100 }),
    search: normalizeSearchString(search.search),
    sort: normalizeEnumSearchParam(
      search.sort,
      ABANDONED_CHECKOUT_SORTS,
      "updatedAt",
    ),
    order: normalizeEnumSearchParam(
      search.order,
      ["asc", "desc"] as const,
      "desc",
    ),
  };
}

export function abandonedCheckoutRouteStateToQuery(
  state: AbandonedCheckoutRouteState,
) {
  return {
    page: state.page,
    limit: state.limit,
    search: state.search || undefined,
    sort: state.sort,
    order: state.order,
  };
}
