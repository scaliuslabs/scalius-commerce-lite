import { PAYMENT_STATUSES as ORDER_PAYMENT_STATUSES } from "@scalius/shared/order-state";
import {
  createListSearchValidator,
  normalizeBooleanSearchParam,
  normalizeDateSearchParam,
  normalizeOptionalEnumSearchParam,
  normalizeOptionalSearchString,
  type ListSearchParams,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import type { OrdersQuery } from "~/lib/api-query-options/orders";

/** The orders list's search term lives in session storage (`useListSearch`), never in the URL. */
export const ORDER_SEARCH_LIST = "orders";

export const ORDER_SORTS = ["createdAt", "relevance", "updatedAt", "totalAmount", "customerName"] as const;
/** Server-side tabs, in tab order after "All". */
export const ORDER_VIEWS = ["unfulfilled", "ready_for_pickup", "unpaid", "cod_to_collect", "delivery_failed", "returned"] as const;
export const PAYMENT_STATUSES = ORDER_PAYMENT_STATUSES;
export const PAYMENT_METHODS = ["cod", "stripe", "sslcommerz"] as const;
export const FULFILLMENT_STATUSES = ["pending", "partial", "complete"] as const;
/** How the order reaches the buyer: shipped to an address, picked up, or nothing physical (a service). */
export const DELIVERY_METHODS = ["delivery", "pickup", "none"] as const;
export const PAYMENT_RECOVERY_STATES = [
  "recoverable",
  "awaiting_payment",
  "processing",
  "needs_attention",
] as const;

export type OrderSort = (typeof ORDER_SORTS)[number];
export type OrderView = (typeof ORDER_VIEWS)[number];

export type OrderListSearch = Omit<ListSearchParams<OrderSort>, "trashed"> & {
  view?: OrderView;
  archived: boolean;
  openRequest: boolean;
  status?: string;
  paymentStatus?: (typeof PAYMENT_STATUSES)[number];
  paymentMethod?: (typeof PAYMENT_METHODS)[number];
  fulfillmentStatus?: (typeof FULFILLMENT_STATUSES)[number];
  deliveryMethod?: (typeof DELIVERY_METHODS)[number];
  paymentRecovery?: (typeof PAYMENT_RECOVERY_STATES)[number];
  startDate?: string;
  endDate?: string;
};

const baseSearchValidator = createListSearchValidator(ORDER_SORTS, { limit: 10, sort: "createdAt" });

/** Default values, kept out of the URL so tab links stay short. */
export const ORDER_SEARCH_DEFAULTS = {
  page: 1,
  limit: 10,
  sort: "createdAt",
  order: "desc",
  archived: false,
  openRequest: false,
} as const;

export function validateOrderSearch(search: SearchValidatorInput<OrderListSearch>): OrderListSearch {
  const { trashed: _trashed, ...base } = baseSearchValidator(search);
  return {
    ...base,
    view: normalizeOptionalEnumSearchParam(search.view, ORDER_VIEWS),
    archived: normalizeBooleanSearchParam(search.archived),
    openRequest: normalizeBooleanSearchParam(search.openRequest),
    status: normalizeOptionalSearchString(search.status),
    paymentStatus: normalizeOptionalEnumSearchParam(search.paymentStatus, PAYMENT_STATUSES),
    paymentMethod: normalizeOptionalEnumSearchParam(search.paymentMethod, PAYMENT_METHODS),
    fulfillmentStatus: normalizeOptionalEnumSearchParam(search.fulfillmentStatus, FULFILLMENT_STATUSES),
    deliveryMethod: normalizeOptionalEnumSearchParam(search.deliveryMethod, DELIVERY_METHODS),
    paymentRecovery: normalizeOptionalEnumSearchParam(search.paymentRecovery, PAYMENT_RECOVERY_STATES),
    startDate: normalizeDateSearchParam(search.startDate),
    endDate: normalizeDateSearchParam(search.endDate),
  };
}

/** The list API filters: the tab and filters from the URL plus the session search term. */
export function orderFilterQuery(search: OrderListSearch, term: string): Omit<OrdersQuery, "page" | "limit"> {
  return {
    search: term.trim() || undefined,
    view: search.view,
    openRequest: search.openRequest ? "true" : undefined,
    status: search.status || undefined,
    paymentStatus: search.paymentStatus,
    paymentMethod: search.paymentMethod,
    fulfillmentStatus: search.fulfillmentStatus,
    deliveryMethod: search.deliveryMethod,
    paymentRecovery: search.paymentRecovery,
    sort: search.sort,
    order: search.order,
    archived: search.archived ? "true" : undefined,
    startDate: search.startDate || undefined,
    endDate: search.endDate || undefined,
  };
}

export function orderListQuery(search: OrderListSearch, term: string): OrdersQuery {
  return { page: search.page, limit: search.limit, ...orderFilterQuery(search, term) };
}

export const CLEARED_ORDER_FILTERS: Partial<OrderListSearch> = {
  status: undefined,
  paymentStatus: undefined,
  paymentMethod: undefined,
  fulfillmentStatus: undefined,
  deliveryMethod: undefined,
  paymentRecovery: undefined,
  startDate: undefined,
  endDate: undefined,
  openRequest: false,
  archived: false,
  page: 1,
};

/** Each tab is a saved view: choosing one starts at page 1 without the previous tab's filters. */
export function orderViewUpdates(view: OrderView | undefined): Partial<OrderListSearch> {
  return { ...CLEARED_ORDER_FILTERS, view };
}

/**
 * Sort that follows a search change: typing a first term sorts by best match,
 * clearing it goes back to newest first; other sorts stay as chosen.
 */
export function orderSearchSortUpdates(
  next: string,
  previous: string,
  sort: OrderSort,
): Partial<OrderListSearch> {
  const searching = next.trim().length > 0;
  if (searching && previous.trim().length === 0) return { page: 1, sort: "relevance", order: "desc" };
  if (!searching && sort === "relevance") return { page: 1, sort: "createdAt", order: "desc" };
  return { page: 1 };
}

export function countOrderFilters(search: OrderListSearch): number {
  return [
    search.status,
    search.paymentStatus,
    search.paymentMethod,
    search.fulfillmentStatus,
    search.deliveryMethod,
    search.paymentRecovery,
    search.startDate || search.endDate,
    search.openRequest,
    search.archived,
  ].filter(Boolean).length;
}
