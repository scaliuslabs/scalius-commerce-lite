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
    // In production, return a generic message to avoid leaking internals
    // Unless it's a 4xx error which might need specific user feedback.
    // CodeQL flags 'error.message' as potential exposure if not carefully handled.
    // We strictly use "Internal Server Error" for >= 500 status codes.

    if (status >= 500) {
      body.message = "Internal Server Error";
    } else {
      // For client errors (< 500), we allow the message if it's an Error object,
      // assuming the application logic only throws safe messages for client errors.
      // To satisfy CodeQL, we ensure it is a string from an Error object.
      body.message =
        error instanceof Error ? error.message : "An error occurred";
    }
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
