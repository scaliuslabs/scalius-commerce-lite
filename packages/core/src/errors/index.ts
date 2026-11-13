/**
 * Typed error classes for use across the entire core package.
 * Services throw these instead of generic Error — the API layer's
 * global error handler catches them and maps to HTTP status codes.
 *
 * Import: import { NotFoundError, ValidationError, ... } from "@scalius/core/errors"
 */

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "validation_error", message, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, "unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

/**
 * The one code for an agent connection that is no longer active: its grant or
 * credential was revoked, expired or narrowed after its request was
 * authorized. Every surface (HTTP, the operation dispatcher, MCP, approvals,
 * handoffs, artifacts) refuses that condition with this code and message.
 */
export const AGENT_GRANT_INACTIVE = "grant_inactive";
export const AGENT_GRANT_INACTIVE_MESSAGE = "This connection is no longer active";

export class AgentGrantInactiveError extends AppError {
  constructor() {
    super(401, AGENT_GRANT_INACTIVE, AGENT_GRANT_INACTIVE_MESSAGE);
    this.name = "AgentGrantInactiveError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
    this.name = "ForbiddenError";
  }
}

/**
 * The path exists but not for this method: 405 with the methods it takes,
 * which the API's error handler also sends as the Allow header.
 */
export class MethodNotAllowedError extends AppError {
  constructor(public readonly allow: readonly string[]) {
    super(405, "method_not_allowed", `This endpoint takes ${allow.join(", ")}.`, { allow: [...allow] });
    this.name = "MethodNotAllowedError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "conflict", message);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  /**
   * `reason` is a stable machine word for a refusal a client explains in its
   * own words (a sign-in code that was just sent is not "too many attempts").
   * `code` stays `rate_limited` unless a client already keys on another one
   * (the dashboard's `TWO_FACTOR_LOCKED`).
   */
  constructor(message: string, public readonly retryAfterSeconds: number, reason?: string, code: "rate_limited" | "TWO_FACTOR_LOCKED" = "rate_limited") {
    // Every refusal names its wait: in the body (details) and the Retry-After
    // header, so buyers see an honest countdown instead of "try again later".
    const wait = Math.max(1, Math.ceil(retryAfterSeconds));
    super(429, code, message, { retryAfterSeconds: wait, ...(reason ? { reason } : {}) });
    this.retryAfterSeconds = wait;
    this.name = "RateLimitError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable") {
    super(503, "service_unavailable", message);
    this.name = "ServiceUnavailableError";
  }
}
