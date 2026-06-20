import { ServiceUnavailableError } from "../../utils/api-error";

export const PAYMENT_SESSION_PROVIDER_TIMEOUT_MS = 12_000;
export const PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS = 11_000;

export type TimeoutAwarePaymentResult = {
  success: boolean;
  error?: string;
  timedOut?: boolean;
};

export function createPaymentProviderTimeoutError(providerName: string): ServiceUnavailableError {
  return new ServiceUnavailableError(`${providerName} did not respond in time. Please try again shortly.`);
}

export function isPaymentProviderTimedOut(result: TimeoutAwarePaymentResult): boolean {
  return result.timedOut === true;
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

export async function withPaymentProviderDeadline<T>(
  providerName: string,
  run: (signal: AbortSignal, requestTimeoutMs: number) => Promise<T>,
  options: {
    deadlineMs?: number;
    requestTimeoutMs?: number;
  } = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? PAYMENT_SESSION_PROVIDER_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(createPaymentProviderTimeoutError(providerName)), deadlineMs);

  try {
    return await run(controller.signal, requestTimeoutMs);
  } catch (error: unknown) {
    if (controller.signal.aborted || isAbortLikeError(error)) {
      throw createPaymentProviderTimeoutError(providerName);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
