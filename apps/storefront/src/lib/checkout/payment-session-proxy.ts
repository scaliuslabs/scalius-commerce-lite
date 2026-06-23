export const PAYMENT_SESSION_PROXY_TIMEOUT_MS = 15_000;
export const PAYMENT_SESSION_PROCESSING_MESSAGE = "Payment is still being prepared. Please try again shortly.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPaymentSessionProcessingPayload(value: unknown): value is Record<string, unknown> & {
  status: "processing";
} {
  return isRecord(value) && value.status === "processing";
}

export function getPaymentSessionProcessingMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
    return value.message;
  }
  return PAYMENT_SESSION_PROCESSING_MESSAGE;
}

export function paymentSessionProxySuccessResponse(
  res: Response,
  json: { data?: Record<string, unknown> } | Record<string, unknown>,
): Response {
  const source: Record<string, unknown> = isRecord(json) ? json : {};
  const unwrapped: Record<string, unknown> = isRecord(source.data) ? source.data : source;
  const isProcessing = res.status === 202 || isPaymentSessionProcessingPayload(unwrapped);
  const headers = new Headers({ "Content-Type": "application/json" });

  if (isProcessing) {
    const retryAfterSeconds = isRecord(unwrapped) && typeof unwrapped.retryAfterSeconds === "number"
      ? Math.max(1, Math.ceil(unwrapped.retryAfterSeconds))
      : 2;
    headers.set("Retry-After", String(retryAfterSeconds));
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify({
      retryable: true,
      ...unwrapped,
      status: "processing",
      message: getPaymentSessionProcessingMessage(unwrapped),
      retryAfterSeconds,
    }), {
      status: 202,
      headers,
    });
  }

  return new Response(JSON.stringify(unwrapped), {
    status: 200,
    headers,
  });
}

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

export function getPaymentSessionProxyExceptionMessage(error: unknown): string {
  return isAbortLikeError(error)
    ? "Payment gateway is taking longer than expected. Please try again shortly."
    : "Payment gateway error";
}

export function paymentSessionProxyErrorResponse(error: unknown): Response {
  const isTimeout = isAbortLikeError(error);
  return new Response(
    JSON.stringify({
      error: getPaymentSessionProxyExceptionMessage(error),
    }),
    {
      status: isTimeout ? 503 : 500,
      headers: { "Content-Type": "application/json" },
    },
  );
}
