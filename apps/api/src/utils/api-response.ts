import type { Context } from "hono";
import { ApiError } from "./api-error";
import { logOpsEvent } from "./ops-log";

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

function safeUnexpectedErrorMetadata(err: unknown): {
  errorName: string;
  infrastructureCode?: string;
  upstreamStatus?: number;
} {
  if (!(err instanceof Error)) return { errorName: typeof err };

  const candidate = err as Error & { code?: unknown };
  const infrastructureCode =
    typeof candidate.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.code)
      ? candidate.code
      : undefined;
  const upstreamStatusMatch = candidate.message.match(
    /^HTTP error! status: ([45][0-9]{2})$/i,
  );
  const upstreamStatus = upstreamStatusMatch
    ? Number(upstreamStatusMatch[1])
    : undefined;

  return {
    errorName: candidate.name,
    infrastructureCode,
    upstreamStatus,
  };
}

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

export function logApiError(
  err: unknown,
  request?: { method?: string; path?: string; requestId?: string; cfRay?: string },
): void {
  if (err instanceof ApiError) {
    if (err.status < 500) return;

    const metadata = {
      status: err.status,
      code: err.code,
      message: err.message,
      method: request?.method,
      path: request?.path,
      requestId: request?.requestId,
      cfRay: request?.cfRay,
    };
    if (err.status === 503) {
      logOpsEvent("warn", "api.error", metadata);
      return;
    }
    logOpsEvent("error", "api.error", metadata);
    return;
  }

  logOpsEvent("error", "api.error", {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Unexpected API error",
    method: request?.method,
    path: request?.path,
    requestId: request?.requestId,
    cfRay: request?.cfRay,
    ...safeUnexpectedErrorMetadata(err),
  });
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
