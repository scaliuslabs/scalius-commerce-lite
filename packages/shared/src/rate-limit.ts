/**
 * Extract the client IP from a request using CF-Connecting-IP (preferred)
 * with fallback to x-forwarded-for for local dev. Rate limiting itself uses the
 * native Workers Rate Limiting bindings (apps/api/src/utils/rate-limit.ts).
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
