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
}

export const DEFAULT_LIST_MAX_LIMIT = 100;

export interface ListSearchParams<TSort extends string = string> {
  page: number;
  limit: number;
  search: string;
  sort: TSort;
  order: "asc" | "desc";
  trashed: boolean;
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
  },
) {
  const defaultLimit = normalizeListPositiveInteger(
    defaults?.limit ?? 10,
    10,
    { max: DEFAULT_LIST_MAX_LIMIT },
  );
  const defaultSort = (defaults?.sort ?? sortOptions[0]) as T[number];
  const defaultOrder = defaults?.order ?? "desc";

  return (
    search: SearchInput<ListSearchParams<T[number]>>,
  ): ListSearchParams<T[number]> => ({
    page: normalizeListPositiveInteger(search.page, 1),
    limit: normalizeListPositiveInteger(search.limit, defaultLimit, {
      max: DEFAULT_LIST_MAX_LIMIT,
    }),
    search: normalizeSearchString(search.search),
    sort: normalizeEnumSearchParam(search.sort, sortOptions, defaultSort),
    order: normalizeEnumSearchParam(search.order, ["asc", "desc"] as const, defaultOrder),
    trashed: normalizeBooleanSearchParam(search.trashed),
  });
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
    return {
      data: (data[key] ?? []) as T[],
      pagination: (data.pagination ?? DEFAULT_PAGINATION) as PaginationInfo,
    };
  };
}
