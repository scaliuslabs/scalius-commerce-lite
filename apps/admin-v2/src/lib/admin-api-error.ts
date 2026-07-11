/**
 * Status-preserving error returned by the admin API transport.
 *
 * Keep this module client-safe: TanStack Start serializes server-function
 * failures before a client-side route loader observes them.
 */
export class AdminApiResponseError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AdminApiResponseError";
    this.status = status;
    this.code = code;
  }
}

function readHttpStatus(
  value: unknown,
  seen = new Set<object>(),
): number | null {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const candidate = value as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
  };
  for (const status of [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
  ]) {
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return status;
    }
  }

  return readHttpStatus(candidate.cause, seen);
}

export function isAdminApiNotFoundError(error: unknown): boolean {
  return readHttpStatus(error) === 404;
}

/**
 * Converts only an authoritative API 404 to the detail-loader absence sentinel.
 * Every other failure must reach the route error boundary.
 */
export function nullForAdminApiNotFound(error: unknown): null {
  if (isAdminApiNotFoundError(error)) return null;
  throw error;
}
