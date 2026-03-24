/**
 * KV-based rate limiter for Cloudflare Workers.
 *
 * Uses KV with TTL for automatic expiry — no setInterval needed.
 * Accepts CF-Connecting-IP (not spoofable) for IP identification.
 */

interface RateLimitOptions {
  kv: KVNamespace;
  /** Unique key for this limit (e.g. IP address, user ID) */
  key: string;
  /** Max requests allowed within the window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix timestamp (ms) when the window resets */
  resetAt: number;
}

/**
 * Check and increment a rate limit counter stored in KV.
 *
 * Each key stores JSON `{ count, resetAt }` with a TTL matching the window.
 */
export async function rateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const { kv, key, limit, windowMs } = options;
  const kvKey = `rl:${key}`;
  const now = Date.now();

  const raw = await kv.get(kvKey);
  let count = 0;
  let resetAt = now + windowMs;

  if (raw) {
    try {
      const stored = JSON.parse(raw) as { count: number; resetAt: number };
      // If the stored window hasn't expired, use it
      if (stored.resetAt > now) {
        count = stored.count;
        resetAt = stored.resetAt;
      }
      // else: expired entry, start fresh (count=0, new resetAt)
    } catch {
      // Corrupted entry, start fresh
    }
  }

  count++;

  // Cloudflare KV requires expirationTtl >= 60 seconds
  const ttlSeconds = Math.max(60, Math.ceil((resetAt - now) / 1000));
  await kv.put(kvKey, JSON.stringify({ count, resetAt }), { expirationTtl: ttlSeconds });

  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);

  return { allowed, remaining, resetAt };
}

/**
 * Extract the client IP from a request using CF-Connecting-IP (preferred)
 * with fallback to x-forwarded-for for local dev.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
