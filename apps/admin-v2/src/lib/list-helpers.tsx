/**
 * Shared helpers for list route patterns.
 *
 * Eliminates copy-pasted search schemas and data selectors across admin list
 * routes. Keep route UI boundaries in `route-error.tsx` so simple routes do
 * not pull Zod through this helper.
 */

import { z } from "zod";

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

// ═══════════════════════════════════════════════════════════════════
//  createListSearchSchema
// ═══════════════════════════════════════════════════════════════════

/**
 * Creates a Zod search schema for list routes with standard pagination,
 * search, sorting, and trash support.
 *
 * The returned schema can be extended with `.extend({})` for route-specific
 * fields (e.g., orders adds `status`, `paymentStatus`; discounts adds `type`).
 *
 * @example
 * ```ts
 * const searchSchema = createListSearchSchema(
 *   ["name", "createdAt", "updatedAt"] as const,
 *   { sort: "updatedAt" }
 * );
 *
 * // Extend for extra fields:
 * const orderSearchSchema = createListSearchSchema(
 *   ["customerName", "totalAmount", "status", "createdAt", "updatedAt"] as const,
 *   { limit: 10 }
 * ).extend({
 *   status: z.string().optional().catch(undefined),
 *   paymentStatus: z.string().optional().catch(undefined),
 * });
 * ```
 */
export function createListSearchSchema<T extends readonly [string, ...string[]]>(
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

  return z.object({
    page: z.preprocess(
      (value) => normalizeListPositiveInteger(value, 1),
      z.number(),
    ).default(1).catch(1),
    limit: z.preprocess(
      (value) =>
        normalizeListPositiveInteger(value, defaultLimit, {
          max: DEFAULT_LIST_MAX_LIMIT,
        }),
      z.number(),
    ).default(defaultLimit).catch(defaultLimit),
    search: z.string().default("").catch(""),
    sort: z.enum(sortOptions).default(defaultSort).catch(defaultSort),
    order: z.enum(["asc", "desc"] as const).default(defaultOrder).catch(defaultOrder),
    trashed: z.boolean().default(false).catch(false),
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
