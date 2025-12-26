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
  const isDev = process.env.NODE_ENV === "development";

  // Prepare the response body
  let body: Record<string, any> = {
    status: "error",
    timestamp: new Date().toISOString(),
  };

  if (isDev) {
    // In development, return detailed error information
    body.message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) {
      body.stack = error.stack;
    }
    body.originalError = error;
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
