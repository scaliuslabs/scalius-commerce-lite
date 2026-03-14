/**
 * Re-export error classes from @scalius/core/errors.
 * Routes can continue importing from this file — the canonical source is the core package.
 *
 * ApiError is kept as an alias for AppError for backward compatibility with
 * the global error handler in app.ts which checks `instanceof ApiError`.
 */
export {
  AppError as ApiError,
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
} from "@scalius/core/errors";
