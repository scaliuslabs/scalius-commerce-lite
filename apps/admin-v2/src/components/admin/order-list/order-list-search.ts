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

export const ORDER_SORTS = [
  "relevance",
  "customerName",
  "totalAmount",
  "status",
  "createdAt",
  "updatedAt",
] as const;
export const ORDER_VIEWS = ["unfulfilled", "unpaid"] as const;
export const STATUS_GROUPS = ["open", "in_transit", "delivered", "closed"] as const;
export const PAYMENT_STATUSES = ["unpaid", "partial", "paid", "refunded", "failed"] as const;
export const PAYMENT_METHODS = ["cod", "stripe", "sslcommerz"] as const;
export const FULFILLMENT_STATUSES = ["pending", "partial", "complete"] as const;
export const PAYMENT_RECOVERY_STATES = [
  "recoverable",
  "needs_attention",
  "processing",
  "awaiting_payment",
] as const;

export type OrderSort = (typeof ORDER_SORTS)[number];
export type OrderView = (typeof ORDER_VIEWS)[number];

export type OrderListSearch = Omit<ListSearchParams<OrderSort>, "trashed"> & {
  view?: OrderView;
  archived: boolean;
  status?: string;
  statusGroup?: (typeof STATUS_GROUPS)[number];
  paymentStatus?: (typeof PAYMENT_STATUSES)[number];
  paymentMethod?: (typeof PAYMENT_METHODS)[number];
  fulfillmentStatus?: (typeof FULFILLMENT_STATUSES)[number];
  paymentRecovery?: (typeof PAYMENT_RECOVERY_STATES)[number];
  startDate?: string;
  endDate?: string;
};

const baseSearchValidator = createListSearchValidator(ORDER_SORTS, {
  limit: 10,
  sort: "updatedAt",
});

/** Default values, kept out of the URL so tab links stay short. */
export const ORDER_SEARCH_DEFAULTS = {
  page: 1,
  limit: 10,
  search: "",
  sort: "updatedAt",
  order: "desc",
  archived: false,
} as const;

export function validateOrderSearch(
  search: SearchValidatorInput<OrderListSearch>,
): OrderListSearch {
  const { trashed: _trashed, ...base } = baseSearchValidator(search);
  return {
    ...base,
    view: normalizeOptionalEnumSearchParam(search.view, ORDER_VIEWS),
    archived: normalizeBooleanSearchParam(search.archived),
    status: normalizeOptionalSearchString(search.status),
    statusGroup: normalizeOptionalEnumSearchParam(search.statusGroup, STATUS_GROUPS),
    paymentStatus: normalizeOptionalEnumSearchParam(search.paymentStatus, PAYMENT_STATUSES),
    paymentMethod: normalizeOptionalEnumSearchParam(search.paymentMethod, PAYMENT_METHODS),
    fulfillmentStatus: normalizeOptionalEnumSearchParam(
      search.fulfillmentStatus,
      FULFILLMENT_STATUSES,
    ),
    paymentRecovery: normalizeOptionalEnumSearchParam(
      search.paymentRecovery,
      PAYMENT_RECOVERY_STATES,
    ),
    startDate: normalizeDateSearchParam(search.startDate),
    endDate: normalizeDateSearchParam(search.endDate),
  };
}

/** The filters with the selected tab's preset applied (only where the merchant set nothing). */
export function effectiveOrderFilters(search: OrderListSearch): OrderListSearch {
  if (search.view === "unfulfilled" && !search.status && !search.statusGroup) {
    return { ...search, statusGroup: "open" };
  }
  if (search.view === "unpaid" && !search.paymentStatus) {
    return { ...search, paymentStatus: "unpaid" };
  }
  return search;
}

export function orderListQuery(search: OrderListSearch): OrdersQuery {
  const filters = effectiveOrderFilters(search);
  return {
    page: filters.page,
    limit: filters.limit,
    search: filters.search || undefined,
    status: filters.status || undefined,
    statusGroup: filters.statusGroup,
    paymentStatus: filters.paymentStatus,
    paymentMethod: filters.paymentMethod,
    fulfillmentStatus: filters.fulfillmentStatus,
    paymentRecovery: filters.paymentRecovery,
    sort: filters.sort,
    order: filters.order,
    archived: filters.archived ? "true" : undefined,
    startDate: filters.startDate || undefined,
    endDate: filters.endDate || undefined,
  };
}

/** Choosing a tab starts at page 1 and drops the filters the tab replaces. */
export function orderViewUpdates(view: OrderView | undefined): Partial<OrderListSearch> {
  return {
    view,
    status: undefined,
    statusGroup: undefined,
    paymentStatus: undefined,
    page: 1,
  };
}

/** A filter change starts at page 1 and leaves a tab it contradicts. */
export function orderFilterUpdates(
  search: Pick<OrderListSearch, "view">,
  patch: Partial<OrderListSearch>,
): Partial<OrderListSearch> {
  const leavesTab =
    (search.view === "unfulfilled" && Boolean(patch.status || patch.statusGroup))
    || (search.view === "unpaid" && Boolean(patch.paymentStatus));
  return { ...patch, page: 1, ...(leavesTab ? { view: undefined } : {}) };
}

/** Searching sorts by best match; clearing the search goes back to recent activity. */
export function orderSearchUpdates(
  value: string,
  current: Pick<OrderListSearch, "search" | "sort">,
): Partial<OrderListSearch> {
  const hasNext = value.trim().length > 0;
  if (hasNext && current.search.trim().length === 0) {
    return { search: value, page: 1, sort: "relevance", order: "desc" };
  }
  if (!hasNext && current.sort === "relevance") {
    return { search: value, page: 1, sort: "updatedAt", order: "desc" };
  }
  return { search: value, page: 1 };
}

export const CLEARED_ORDER_FILTERS: Partial<OrderListSearch> = {
  status: undefined,
  statusGroup: undefined,
  paymentStatus: undefined,
  paymentMethod: undefined,
  fulfillmentStatus: undefined,
  paymentRecovery: undefined,
  startDate: undefined,
  endDate: undefined,
  archived: false,
  page: 1,
};

export function countOrderFilters(search: OrderListSearch): number {
  return [
    search.status || search.statusGroup,
    search.paymentStatus,
    search.paymentMethod,
    search.fulfillmentStatus,
    search.paymentRecovery,
    search.startDate || search.endDate,
    search.archived,
  ].filter(Boolean).length;
}
