const NON_RETRYABLE_STATUS_PATTERNS = [
  /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
  /api\s*(?:key|token)\s+(?:invalid|expired|missing)/i,
  /permission/i,
  /sender/i,
  /insufficient\s+(?:balance|credit)/i,
  /\bbalance\b/i,
  /account\s+(?:expired|suspended|inactive|disabled)/i,
  /invalid\s+(?:number|mobile|recipient|msisdn)/i,
  /blacklist/i,
  /message\s+(?:empty|too\s+long|length)/i,
];

const RETRYABLE_STATUS_PATTERNS = [
  /timeout/i,
  /temporar/i,
  /try\s+again/i,
  /rate\s+limit/i,
  /too\s+many/i,
  /server/i,
  /unavailable/i,
  /gateway/i,
  /network/i,
];

export function isRetryableSmsHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function classifySmsProviderFailure(rawStatus: string | undefined, httpStatus?: number): boolean {
  if (httpStatus !== undefined) return isRetryableSmsHttpStatus(httpStatus);
  const status = rawStatus?.trim();
  if (!status) return true;
  if (NON_RETRYABLE_STATUS_PATTERNS.some((pattern) => pattern.test(status))) return false;
  if (RETRYABLE_STATUS_PATTERNS.some((pattern) => pattern.test(status))) return true;
  return true;
}

export function sanitizeSmsProviderDiagnostic(rawStatus: string | undefined): string | undefined {
  const sanitized = rawStatus
    ?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
    .replace(/((?:bearer|token|api[_ -]?key|secret))\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || undefined;
}
