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
  const defaultLimit = defaults?.limit ?? 10;
  const defaultSort = (defaults?.sort ?? sortOptions[0]) as T[number];
  const defaultOrder = defaults?.order ?? "desc";

  return z.object({
    page: z.number().default(1).catch(1),
    limit: z.number().default(defaultLimit).catch(defaultLimit),
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
