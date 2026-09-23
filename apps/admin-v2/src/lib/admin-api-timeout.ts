export const ADMIN_API_READ_TIMEOUT_MS = 15_000;
export const ADMIN_API_READ_TIMEOUT_CODE = "ADMIN_API_READ_TIMEOUT";

export class AdminApiReadTimeoutError extends Error {
  readonly code = ADMIN_API_READ_TIMEOUT_CODE;
  readonly status = 504;

  constructor(timeoutMs = ADMIN_API_READ_TIMEOUT_MS) {
    super(
      `Admin API read timed out after ${Math.round(timeoutMs / 1000)}s. Please retry.`,
    );
    this.name = "AdminApiReadTimeoutError";
  }
}

/**
 * Reads (GET/HEAD) give up after `timeoutMs`, headers and body included, so a
 * stalled read surfaces a retryable error instead of a spinner. Writes are
 * never cut short: a timed-out write could still commit.
 */
export function adminApiReadSignal(
  method: string,
  parent?: AbortSignal,
  timeoutMs = ADMIN_API_READ_TIMEOUT_MS,
): AbortSignal | undefined {
  const normalized = method.toUpperCase();
  if (normalized !== "GET" && normalized !== "HEAD") return parent;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AdminApiReadTimeoutError(timeoutMs)), timeoutMs);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
}
