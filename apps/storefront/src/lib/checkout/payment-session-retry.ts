import {
  getPaymentSessionProcessingMessage,
  isPaymentSessionProcessingPayload,
} from "./payment-session-proxy";

export const PAYMENT_SESSION_RETRY_TOTAL_MS = 25_000;
export const PAYMENT_SESSION_RETRY_MAX_ATTEMPTS = 12;
const PAYMENT_SESSION_RETRY_DEFAULT_DELAY_MS = 2_000;
const PAYMENT_SESSION_RETRY_MIN_DELAY_MS = 2_000;

export interface PaymentSessionRetryEvent {
  attempt: number;
  elapsedMs: number;
  message: string;
  nextRetryDelayMs: number;
  retryAfterSeconds: number;
}

export interface PaymentSessionRetryOptions {
  maxAttempts?: number;
  maxElapsedMs?: number;
  now?: () => number;
  onProcessing?: (event: PaymentSessionRetryEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PaymentSessionRetryResult<T = Record<string, unknown>> {
  attempts: number;
  data: T;
  response: Response;
}

export class PaymentSessionProcessingTimeoutError extends Error {
  attempts: number;
  retryAfterSeconds: number;
  status = 202;

  constructor(message: string, options: { attempts: number; retryAfterSeconds: number }) {
    super(message);
    this.name = "PaymentSessionProcessingTimeoutError";
    this.attempts = options.attempts;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapPaymentSessionPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.data) ? value.data : value;
}

function parseRetryAfterHeader(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const delaySeconds = Math.ceil((timestamp - nowMs) / 1000);
  return delaySeconds > 0 ? delaySeconds : null;
}

function bodyRetryAfterSeconds(payload: Record<string, unknown>): number | null {
  const value = payload.retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function retryAfterSeconds(response: Response, payload: Record<string, unknown>, nowMs: number): number {
  const headerValue = typeof response.headers?.get === "function"
    ? response.headers.get("Retry-After")
    : null;
  const value = bodyRetryAfterSeconds(payload) ?? parseRetryAfterHeader(headerValue, nowMs);
  return Math.max(1, Math.ceil(value ?? PAYMENT_SESSION_RETRY_DEFAULT_DELAY_MS / 1000));
}

function retryDelayMs(seconds: number): number {
  return Math.max(PAYMENT_SESSION_RETRY_MIN_DELAY_MS, seconds * 1000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function readPaymentSessionJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export async function fetchPaymentSessionWithProcessingRetry<T = Record<string, unknown>>(
  fetchSession: () => Promise<Response>,
  options: PaymentSessionRetryOptions = {},
): Promise<PaymentSessionRetryResult<T>> {
  const maxAttempts = options.maxAttempts ?? PAYMENT_SESSION_RETRY_MAX_ATTEMPTS;
  const maxElapsedMs = options.maxElapsedMs ?? PAYMENT_SESSION_RETRY_TOTAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    const response = await fetchSession();
    const data = await readPaymentSessionJson(response);
    const payload = unwrapPaymentSessionPayload(data);
    const isProcessing = response.status === 202 || isPaymentSessionProcessingPayload(payload);

    if (!isProcessing) {
      return { attempts, data: data as T, response };
    }

    const currentTime = now();
    const elapsedMs = Math.max(0, currentTime - startedAt);
    const retrySeconds = retryAfterSeconds(response, payload, currentTime);
    const nextRetryDelayMs = retryDelayMs(retrySeconds);
    const message = getPaymentSessionProcessingMessage(payload);

    if (attempts >= maxAttempts || elapsedMs + nextRetryDelayMs > maxElapsedMs) {
      throw new PaymentSessionProcessingTimeoutError(message, {
        attempts,
        retryAfterSeconds: retrySeconds,
      });
    }

    options.onProcessing?.({
      attempt: attempts,
      elapsedMs,
      message,
      nextRetryDelayMs,
      retryAfterSeconds: retrySeconds,
    });
    await sleep(nextRetryDelayMs);
  }

  throw new PaymentSessionProcessingTimeoutError(
    "Payment is still being prepared. Please try again shortly.",
    { attempts, retryAfterSeconds: PAYMENT_SESSION_RETRY_DEFAULT_DELAY_MS / 1000 },
  );
}
