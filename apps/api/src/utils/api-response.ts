import type { Context } from "hono";
import { ApiError } from "./api-error";

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

type ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

const INTERNAL_ERROR_MESSAGE = "Internal Server Error";

function toErrorStatusCode(status: number): ErrorStatusCode {
  const allowedStatuses: ErrorStatusCode[] = [
    400,
    401,
    403,
    404,
    409,
    422,
    429,
    500,
    503,
  ];

  return allowedStatuses.includes(status as ErrorStatusCode)
    ? (status as ErrorStatusCode)
    : 500;
}

export function errorResponseFromError(err: unknown): {
  body: ApiErrorResponse;
  status: ErrorStatusCode;
} {
  if (err instanceof ApiError) {
    return {
      body: {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      },
      status: toErrorStatusCode(err.status),
    };
  }

  return {
    body: {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: INTERNAL_ERROR_MESSAGE,
      },
    },
    status: 500,
  };
}

/**
 * Return a standard success response: { success: true, data: T }
 *
 * For paginated responses, wrap items in a named field:
 *   ok(c, { products: items, pagination })
 * NOT as a bare array — the admin proxy unwrapper cannot flatten arrays.
 */
export function ok<T>(c: Context, data: T) {
  return c.json({ success: true as const, data }, 200);
}

/** Return a standard created response (201) */
export function created<T>(c: Context, data: T) {
  return c.json({ success: true as const, data }, 201);
}

/** Return a 204 No Content response */
export function noContent(c: Context) {
  return c.body(null, 204);
}
