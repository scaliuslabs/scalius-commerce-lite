/**
 * Unwraps the API response envelope for client-side consumption.
 * Handles both shapes:
 * - Production (admin proxy): { success, ...T } (already unwrapped)
 * - Dev mode (Vite proxy): { success, data: T } (raw envelope)
 *
 * Use this in every client-side fetch() response handler instead of
 * inline `json.data && typeof json.data === "object" ? json.data : json`.
 */
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
