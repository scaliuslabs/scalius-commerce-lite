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
    // Unless it's a 4xx error which might need specific user feedback,
    // but for 500s we generally want to be opaque unless we have a specific AppError type.
    // For this implementation, we will be conservative.
    body.message =
      status >= 500 ? "Internal Server Error" : "An error occurred";

    // If it's a known error type that is safe to expose, logic could be added here.
    // For now, if status is < 500, we assume the message might be safe-ish,
    // but to be strictly safe against the "stack trace exposure" alert,
    // we should usually sanitize unless we explicitly know it's safe.
    // However, often 400s contain validation messages we WANT the user to see.
    if (status < 500 && error instanceof Error) {
      body.message = error.message;
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
