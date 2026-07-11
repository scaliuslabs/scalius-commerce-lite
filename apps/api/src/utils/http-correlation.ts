import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

const REQUEST_ID_HEADER = "X-Request-Id";
const CF_RAY_HEADER = "CF-Ray";
const REQUEST_CORRELATION_KEY = "requestCorrelation";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const SAFE_CF_RAY = /^[A-Za-z0-9_-]{1,128}$/;

export type RequestCorrelation = {
  requestId: string;
  cfRay?: string;
};

function normalizeHeaderValue(
  value: string | undefined,
  pattern: RegExp,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !pattern.test(trimmed)) return undefined;
  return trimmed;
}

export function normalizeRequestId(value: string | undefined): string | undefined {
  return normalizeHeaderValue(value, SAFE_REQUEST_ID);
}

export function normalizeCfRay(value: string | undefined): string | undefined {
  return normalizeHeaderValue(value, SAFE_CF_RAY);
}

function generateRequestId(): string {
  const randomUUID = crypto?.randomUUID?.();
  if (randomUUID) return randomUUID;

  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 14);
  return `req_${time}_${random}`;
}

function getStoredCorrelation(c: Context): RequestCorrelation | undefined {
  const getter = c as unknown as { get?: (key: string) => unknown };
  const value = getter.get?.(REQUEST_CORRELATION_KEY);
  if (
    value &&
    typeof value === "object" &&
    typeof (value as RequestCorrelation).requestId === "string"
  ) {
    return value as RequestCorrelation;
  }
  return undefined;
}

function setStoredCorrelation(c: Context, correlation: RequestCorrelation): void {
  const setter = c as unknown as { set?: (key: string, value: unknown) => void };
  setter.set?.(REQUEST_CORRELATION_KEY, correlation);
}

export function getRequestCorrelation(c: Context): RequestCorrelation {
  const stored = getStoredCorrelation(c);
  if (stored) return stored;

  const requestId =
    normalizeRequestId(c.res.headers.get(REQUEST_ID_HEADER) ?? undefined) ??
    normalizeRequestId(c.req.header(REQUEST_ID_HEADER)) ??
    generateRequestId();
  const cfRay = normalizeCfRay(c.req.header(CF_RAY_HEADER));
  return { requestId, cfRay };
}

export const requestCorrelationMiddleware = createMiddleware(async (c, next) => {
  const correlation = {
    requestId: normalizeRequestId(c.req.header(REQUEST_ID_HEADER)) ?? generateRequestId(),
    cfRay: normalizeCfRay(c.req.header(CF_RAY_HEADER)),
  };

  setStoredCorrelation(c, correlation);
  c.header(REQUEST_ID_HEADER, correlation.requestId);

  try {
    await next();
  } finally {
    c.header(REQUEST_ID_HEADER, correlation.requestId);
  }
});
