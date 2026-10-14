/**
 * Re-export error classes from @scalius/core/errors.
 * Routes can continue importing from this file — the canonical source is the core package.
 */
export {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
} from "@scalius/core/errors";
