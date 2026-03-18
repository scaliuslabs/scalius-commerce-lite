/**
 * Unwraps the API response envelope for client-side consumption.
 * Handles both shapes:
 * - Production (admin proxy): { success, ...T } (already unwrapped)
 * - Dev mode (Vite proxy): { success, data: T } (raw envelope)
 *
 * Use this in every client-side fetch() response handler instead of
 * inline `json.data && typeof json.data === "object" ? json.data : json`.
 */
/**
 * Extract a human-readable error message from an API error response.
 * Handles both shapes:
 * - Proxy-flattened (production): { success: false, error: "message string", errorCode: "CONFLICT" }
 * - Raw API (dev/Vite proxy): { success: false, error: { code: "CONFLICT", message: "..." } }
 * - Plain error: { message: "..." }
 */
export function extractApiError(json: unknown, fallback = "An error occurred"): string {
  if (!json || typeof json !== "object") return fallback;
  const obj = json as Record<string, unknown>;

  // Proxy-flattened: error is a string
  if (typeof obj.error === "string") return obj.error;

  // Raw API: error is { code, message }
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
  }

  // Fallback: top-level message
  if (typeof obj.message === "string") return obj.message;

  return fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapEnvelope<T = any>(json: unknown): T {
  if (
    json &&
    typeof json === "object" &&
    "data" in json &&
    typeof (json as Record<string, unknown>).data === "object" &&
    !Array.isArray((json as Record<string, unknown>).data)
  ) {
    return (json as Record<string, unknown>).data as T;
  }
  return json as T;
}
