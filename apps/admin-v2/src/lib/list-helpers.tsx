/**
 * Shared helpers for list route patterns.
 *
 * Eliminates copy-pasted search schemas and data selectors across admin list
 * routes. Keep route UI boundaries in `route-error.tsx` and keep this helper
 * dependency-free because TanStack's generated route tree eagerly imports
 * route validateSearch code for every route.
 */

import type { SearchSchemaInput } from "@tanstack/react-router";

// ═══════════════════════════════════════════════════════════════════
//  Shared types
// ═══════════════════════════════════════════════════════════════════

export interface PaginationInfo {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  /** `total` is a lower bound: more rows match than the API counts ("1,000+"). */
  totalIsCapped?: boolean;
  /** Zero-based index of this page's first row; null when deeper than the API counts. */
  offset?: number | null;
}

/** Where a cursor-paged list continues (the API's `pageInfo`). */
export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export const DEFAULT_LIST_MAX_LIMIT = 100;

/** Rows per page a list starts with (T12). */
export const DEFAULT_PAGE_SIZE = 50;
/** The page sizes every list offers. */
export const PAGE_SIZE_OPTIONS: readonly number[] = [20, 50, 100];

const PAGE_SIZE_PREFIX = "scalius.pageSize.";

/**
 * The page size the merchant last chose for this list in this browser (T12:
 * "kept per list"), or null. A page link with `limit` still wins.
 */
export function readSavedPageSize(list: string): number | null {
  try {
    const value = Number(localStorage.getItem(PAGE_SIZE_PREFIX + list));
    return PAGE_SIZE_OPTIONS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeSavedPageSize(list: string, size: number): void {
  try {
    if (size === DEFAULT_PAGE_SIZE) localStorage.removeItem(PAGE_SIZE_PREFIX + list);
    else localStorage.setItem(PAGE_SIZE_PREFIX + list, String(size));
  } catch {
    // Storage blocked: the size lasts for this page.
  }
}

export interface ListSearchParams<TSort extends string = string> {
  page: number;
  limit: number;
  sort: TSort;
  order: "asc" | "desc";
  trashed: boolean;
  /** One-time `?q=` deep link; the list moves it into its session term (list-search.ts). */
  q?: string;
  /** Show the rows after this opaque cursor (`pageInfo.endCursor` of the page before). */
  after?: string;
  /** Show the rows before this opaque cursor (`pageInfo.startCursor` of the page after). */
  before?: string;
}

/**
 * A cursor-paged list drops its cursor whenever anything but the cursor
 * changes (filters, sort, page size, search): a cursor is a position in one
 * ordered list, so a new list starts at its first page.
 */
export const NO_CURSOR = { after: undefined, before: undefined } as const;

export function resetCursorUnlessPaging<T extends Record<string, unknown>>(
  updates: T,
): T & Partial<typeof NO_CURSOR> {
  return "after" in updates || "before" in updates ? updates : { ...updates, ...NO_CURSOR };
}

const CURSOR_MAX_LENGTH = 1024;

/** An opaque cursor from the URL: the API decides if it is valid; the URL only keeps it small and URL-safe. */
export function normalizeCursorSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= CURSOR_MAX_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : undefined;
}

/** True for an API paging refusal (`INVALID_CURSOR`, `PAGE_TOO_DEEP`): the list starts again from its first page. */
export function isPagingRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "INVALID_CURSOR" || code === "PAGE_TOO_DEEP";
}

export type SearchValidatorInput<T extends object = object> = {
  [K in keyof T]?: unknown;
} & Record<string, unknown> &
  SearchSchemaInput;

type SearchInput<T extends object> = SearchValidatorInput<T>;

export function normalizeListPositiveInteger(
  value: unknown,
  fallback: number,
  options: { max?: number } = {},
): number {
  const numeric = (() => {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return Number.NaN;
  })();

  if (!Number.isFinite(numeric)) return fallback;

  const integer = Math.trunc(numeric);
  const minBounded = Math.max(1, integer);
  return options.max == null ? minBounded : Math.min(minBounded, options.max);
}

export function getCanonicalPageForPagination(
  page: unknown,
  pagination: Pick<PaginationInfo, "total" | "totalPages">,
): number {
  const currentPage = normalizeListPositiveInteger(page, 1);
  if (pagination.totalPages > 0) {
    return Math.min(currentPage, pagination.totalPages);
  }
  return pagination.total > 0 ? currentPage : 1;
}

export function normalizeSearchString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeOptionalSearchString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** An app filter from the URL: `<app id>/<column id>:<value>`, the API's own limit of 400 characters. */
export function normalizeAppFilterSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 400 && /^[^/:\s]+\/[^:\s]+:[\s\S]+$/.test(value) ? value : undefined;
}

export function normalizeBooleanSearchParam(
  value: unknown,
  fallback = false,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

export function normalizeEnumSearchParam<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && options.includes(value as T)
    ? (value as T)
    : fallback;
}

export function normalizeOptionalEnumSearchParam<T extends string>(
  value: unknown,
  options: readonly T[],
): T | undefined {
  return typeof value === "string" && options.includes(value as T)
    ? (value as T)
    : undefined;
}

export function normalizeDateSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : undefined;
}

// ═══════════════════════════════════════════════════════════════════
//  createListSearchValidator
// ═══════════════════════════════════════════════════════════════════

/**
 * Creates a lightweight validateSearch function for list routes with standard
 * pagination, search, sorting, and trash support.
 *
 * @example
 * ```ts
 * const validateSearch = createListSearchValidator(
 *   ["name", "createdAt", "updatedAt"] as const,
 *   { sort: "updatedAt" }
 * );
 * ```
 */
export function createListSearchValidator<T extends readonly [string, ...string[]]>(
  sortOptions: T,
  defaults?: {
    limit?: number;
    sort?: T[number];
    order?: "asc" | "desc";
    /** The list's name: its page size is the one last chosen in this browser (T12). */
    list?: string;
  },
) {
  const defaultLimit = normalizeListPositiveInteger(
    defaults?.limit ?? DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
    { max: DEFAULT_LIST_MAX_LIMIT },
  );
  const defaultSort = (defaults?.sort ?? sortOptions[0]) as T[number];
  const defaultOrder = defaults?.order ?? "desc";
  const list = defaults?.list;

  return (
    search: SearchInput<ListSearchParams<T[number]>>,
  ): ListSearchParams<T[number]> => ({
    page: normalizeListPositiveInteger(search.page, 1),
    limit: normalizeListPositiveInteger(search.limit, (list ? readSavedPageSize(list) : null) ?? defaultLimit, {
      max: DEFAULT_LIST_MAX_LIMIT,
    }),
    sort: normalizeEnumSearchParam(search.sort, sortOptions, defaultSort),
    order: normalizeEnumSearchParam(search.order, ["asc", "desc"] as const, defaultOrder),
    trashed: normalizeBooleanSearchParam(search.trashed),
    q: normalizeOptionalSearchString(search.q),
    ...normalizeCursorPair(search.after, search.before),
  });
}

/** `after` wins when a hand-edited URL carries both. */
function normalizeCursorPair(after: unknown, before: unknown): { after?: string; before?: string } {
  const cursorAfter = normalizeCursorSearchParam(after);
  if (cursorAfter) return { after: cursorAfter };
  const cursorBefore = normalizeCursorSearchParam(before);
  return cursorBefore ? { before: cursorBefore } : {};
}

// ═══════════════════════════════════════════════════════════════════
//  createDataSelector
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_PAGINATION: PaginationInfo = {
  total: 0,
  page: 1,
  limit: 20,
  totalPages: 0,
};

/** What an app's list column holds for one row. */
export type AppListValue = string | number | boolean | null;
/** A list row after `createDataSelector`: the values the list's one read returned for the apps' columns. */
export interface AppValuesRow {
  appValues?: Record<string, AppListValue>;
}

function withAppValues<T>(row: T, appValues: Record<string, Record<string, AppListValue>>): T {
  const values = appValues[(row as { id?: string }).id ?? ""];
  return values ? { ...row, appValues: values } : row;
}

/**
 * Creates a data selector function that extracts a typed array and
 * pagination info from the raw API response.
 *
 * @param key - The response property containing the entity array
 *              (e.g., "products", "orders", "categories")
 *
 * @example
 * ```ts
 * const dataSelector = createDataSelector<Product>("products");
 * // Returns: { data: Product[], pagination: PaginationInfo }
 * ```
 */
export function createDataSelector<T>(key: string) {
  return (raw: unknown) => {
    const data = raw as Record<string, unknown>;
    const rows = (data[key] ?? []) as T[];
    const appValues = data.appValues as Record<string, Record<string, AppListValue>> | undefined;
    return {
      data: appValues ? rows.map((row) => withAppValues(row, appValues)) : rows,
      pagination: (data.pagination ?? DEFAULT_PAGINATION) as PaginationInfo,
      pageInfo: data.pageInfo as PageInfo | undefined,
    };
  };
}
