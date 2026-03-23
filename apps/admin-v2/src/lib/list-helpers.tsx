/**
 * Shared helpers for list route patterns.
 *
 * Eliminates copy-pasted search schemas, data selectors, and error
 * components across all admin list routes.
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
  const defaultLimit = defaults?.limit ?? 20;
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

// ═══════════════════════════════════════════════════════════════════
//  RouteErrorComponent
// ═══════════════════════════════════════════════════════════════════

/**
 * Shared error component for route-level error boundaries.
 *
 * Displays the error message with a "Try Again" button that calls `reset`.
 *
 * @example
 * ```ts
 * export const Route = createFileRoute("/admin/products/")({
 *   ...
 *   errorComponent: RouteErrorComponent,
 * });
 * ```
 */
export function RouteErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-4xl font-bold text-muted-foreground mb-2">Error</p>
      <p className="text-sm text-muted-foreground mb-4">
        {error instanceof Error ? error.message : "Something went wrong loading this page."}
      </p>
      <button
        onClick={reset}
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Try Again
      </button>
    </div>
  );
}
