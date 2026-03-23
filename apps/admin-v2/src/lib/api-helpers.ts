/**
 * Extract a human-readable error message from an API error response.
 * API returns: { success: false, error: { code: "CONFLICT", message: "..." } }
 */
export function extractApiError(json: unknown, fallback = "An error occurred"): string {
  if (!json || typeof json !== "object") return fallback;
  const obj = json as Record<string, unknown>;

  // Standard API error: error is { code, message }
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
  }

  // Legacy/simple: error is a string
  if (typeof obj.error === "string") return obj.error;

  // Fallback: top-level message
  if (typeof obj.message === "string") return obj.message;

  return fallback;
}

/**
 * Extract validation details from an API error response.
 * API returns: { success: false, error: { code, message, details: [...] } }
 */
export function extractApiErrorDetails(json: unknown): Array<{ path?: string[]; message?: string }> | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    if (Array.isArray(err.details)) return err.details;
  }
  // Legacy flat shape
  if (Array.isArray(obj.details)) return obj.details;
  return null;
}

/**
 * Unwrap the standard API envelope { success, data: T } → T.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapEnvelope<T = any>(json: unknown): T {
  if (
    json &&
    typeof json === "object" &&
    "data" in json
  ) {
    return (json as Record<string, unknown>).data as T;
  }
  return json as T;
}

/**
 * Extract a readable error message from a server function error.
 * Server functions throw Error objects -- the message contains the API error.
 */
export function getServerFnError(error: unknown, fallback = "An error occurred"): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error;
  return fallback;
}
