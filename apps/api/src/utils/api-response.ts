import type { Context } from "hono";

/** Standard success response shape: { success: true, data: T } */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Standard error response shape */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Return a standard success response: { success: true, data: T }
 *
 * For paginated responses, wrap items in a named field:
 *   ok(c, { products: items, pagination })
 * NOT as a bare array — the admin proxy unwrapper cannot flatten arrays.
 */
export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ success: true as const, data }, status);
}

/** Return a standard created response (201) */
export function created<T>(c: Context, data: T) {
  return c.json({ success: true as const, data }, 201);
}

/** Return a 204 No Content response */
export function noContent(c: Context) {
  return c.body(null, 204);
}
