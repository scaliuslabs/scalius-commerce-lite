import type { Context } from "hono";

/** Standard success response shape */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/** Standard paginated response shape */
export interface ApiPaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: PaginationMeta;
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

/** Return a standard success response */
export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ success: true as const, data }, status);
}

/** Return a standard created response (201) */
export function created<T>(c: Context, data: T) {
  return c.json({ success: true as const, data }, 201);
}

/** Return a standard paginated response */
export function paginated<T>(
  c: Context,
  data: T[],
  pagination: PaginationMeta,
) {
  return c.json({ success: true as const, data, pagination }, 200);
}

/** Return a 204 No Content response */
export function noContent(c: Context) {
  return c.body(null, 204);
}
