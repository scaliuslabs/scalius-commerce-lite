export const PAYMENT_SESSION_PROXY_TIMEOUT_MS = 15_000;

export function getPaymentSessionApiErrorMessage(json: { error?: unknown }, fallback: string): string {
  if (typeof json.error === "string") return json.error;
  if (json.error && typeof json.error === "object") {
    const message = (json.error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { name?: unknown; message?: unknown };
  const name = typeof maybeError.name === "string" ? maybeError.name.toLowerCase() : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  return (
    name.includes("abort") ||
    name.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

export function paymentSessionProxyErrorResponse(error: unknown): Response {
  const isTimeout = isAbortLikeError(error);
  return new Response(
    JSON.stringify({
      error: isTimeout
        ? "Payment gateway is taking longer than expected. Please try again shortly."
        : "Payment gateway error",
    }),
    {
      status: isTimeout ? 503 : 500,
      headers: { "Content-Type": "application/json" },
    },
  );
}
