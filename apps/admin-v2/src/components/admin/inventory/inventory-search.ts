import {
  normalizeInventoryWorkspaceSection,
  type InventoryWorkspaceSection,
} from "~/components/admin/inventory-workspace";
import type { inventoryQueryOptions } from "~/lib/api-query-options/inventory";

export const STOCK_FILTERS = ["all", "low", "out", "reserved"] as const;
export const ALERT_FILTERS = ["active", "acknowledged", "resolved", "all"] as const;
export const MOVEMENT_TYPES = [
  "adjusted",
  "reserved",
  "deducted",
  "released",
  "restored",
  "preorder_reserved",
  "preorder_deducted",
] as const;
const MOVEMENT_FILTERS = ["all", ...MOVEMENT_TYPES] as const;

export type StockFilter = (typeof STOCK_FILTERS)[number];
export type AlertFilter = (typeof ALERT_FILTERS)[number];
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export type MovementFilter = (typeof MOVEMENT_FILTERS)[number];

/**
 * Inventory list state in the URL: the tab, enum filters and calendar dates.
 * `q` is only a one-time deep link: the route adopts it as the session search
 * term and removes it from the address.
 */
export type InventorySearch = {
  section: InventoryWorkspaceSection;
  stock: StockFilter;
  alert: AlertFilter;
  type: MovementFilter;
  from: string;
  to: string;
  q?: string;
};

/** Values equal to these are stripped from the URL. */
export const INVENTORY_SEARCH_DEFAULTS = {
  section: "variants",
  stock: "all",
  alert: "active",
  type: "all",
  from: "",
  to: "",
} as const satisfies Omit<InventorySearch, "q">;

/** What a tab filters by: the URL state plus the search term, which lives in the session (`useListSearch("inventory")`). */
export type InventoryFilters = Omit<InventorySearch, "q"> & { q: string };

export type InventoryFiltersChange = (patch: Partial<Omit<InventoryFilters, "section">>) => void;

function pick<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

function calendarDate(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

export function validateInventorySearch(search: Record<string, unknown>): InventorySearch {
  return {
    section: normalizeInventoryWorkspaceSection(search.section),
    stock: pick(search.stock, STOCK_FILTERS, "all"),
    alert: pick(search.alert, ALERT_FILTERS, "active"),
    type: pick(search.type, MOVEMENT_FILTERS, "all"),
    from: calendarDate(search.from),
    to: calendarDate(search.to),
    ...(typeof search.q === "string" ? { q: search.q.trim().slice(0, 120) } : {}),
  };
}

type InventoryQuery = Parameters<typeof inventoryQueryOptions>[0];
export type VariantSort = { field: "productName" | "sku" | "available"; order: "asc" | "desc" };
export const MOVEMENT_PAGE_SIZE = 50;

/** One query builder per tab, shared by the route prefetch and the tab so their cache keys match. */
export const variantsQuery = (
  search: Pick<InventoryFilters, "q" | "stock">,
  page = 1,
  limit = 50,
  sort: VariantSort = { field: "available", order: "asc" },
): InventoryQuery => ({
  section: "variants",
  search: search.q || undefined,
  status: search.stock === "all" ? undefined : search.stock,
  page,
  limit,
  sort: sort.field,
  order: sort.order,
});

export const alertsQuery = (
  search: Pick<InventoryFilters, "q" | "alert">,
  page = 1,
  limit = 50,
): InventoryQuery => ({
  section: "alerts",
  search: search.q || undefined,
  alertStatus: search.alert,
  page,
  limit,
});

export const movementsQuery = (
  search: Pick<InventoryFilters, "q" | "type" | "from" | "to">,
  cursor?: string,
): InventoryQuery => ({
  section: "movements",
  search: search.q || undefined,
  movementType: search.type,
  movementStartDate: search.from || undefined,
  movementEndDate: search.to || undefined,
  movementCursor: cursor || undefined,
  limit: MOVEMENT_PAGE_SIZE,
});
