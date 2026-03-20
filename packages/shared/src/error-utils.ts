/**
 * Standardized error response helper to prevent stack trace leakage.
 *
 * @param error The error object caught in the try/catch block
 * @param status Optional HTTP status code (default: 500)
 * @returns A Response object with a sanitized JSON body
 */
export function safeErrorResponse(error: unknown, status = 500): Response {
  // Always log the full error details on the server for debugging
  console.error("API Error occurred:", error);

  // Determine if we are in development mode
  const isDev = typeof (globalThis as any).process !== "undefined" && (globalThis as any).process.env?.NODE_ENV === "development";

  // Prepare the response body
  let body: Record<string, unknown> = {
    status: "error",
    timestamp: new Date().toISOString(),
  };

  if (isDev) {
    // In development, return only the error message (stack traces logged server-side above)
    body.message = error instanceof Error ? error.message : String(error);
  } else {
    // In production, return typically safe, standard HTTP messages based on status code.
    // We strictly avoid passing dynamic error.message to the client to satisfy CodeQL
    // rule js/stack-trace-exposure and prevent any info leakage.
    const STATUS_MESSAGES: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
      409: "Conflict",
      422: "Unprocessable Entity",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    };

    body.message = STATUS_MESSAGES[status] || "An error occurred";
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

/**
 * Returns a standardized 400 validation error response from a ZodError.
 * Use in Astro API routes when schema.parse() fails.
 */
export function zodErrorResponse(error: { errors: unknown[] }): Response {
  return new Response(
    JSON.stringify({ status: "error", message: "Validation failed", details: error.errors }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Standardized error response helper for Hono routes.
 * Returns c.json() with the same sanitized structure as safeErrorResponse.
 *
 * @param c  Hono Context
 * @param error The caught error
 * @param status Optional HTTP status code (default: 500)
 */
export function honoSafeError(
  c: { json: (body: unknown, status?: number) => unknown },
  error: unknown,
  status = 500,
) {
  console.error("API Error occurred:", error);
  const isDev = typeof (globalThis as any).process !== "undefined" && (globalThis as any).process.env?.NODE_ENV === "development";
  const message = isDev && error instanceof Error ? error.message : "An error occurred";
  return c.json({ success: false, error: message, timestamp: new Date().toISOString() }, status);
}
