/**
 * Readable message for a failed API call (`AdminApiResponseError` carries the
 * API's message) or any other thrown value.
 */
export function getServerFnError(error: unknown, fallback = "An error occurred"): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error;
  return fallback;
}
