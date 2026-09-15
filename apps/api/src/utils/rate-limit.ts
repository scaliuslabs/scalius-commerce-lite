// Prefer the native Workers Rate Limiting binding; it costs no KV operations.
// The KV counter is only the fallback for environments without the binding,
// because every KV-backed check is one read plus one write against the daily
// free-tier write budget.
import { rateLimit } from "@scalius/shared/rate-limit";

export interface EnforceRateLimitOptions {
  limiter: RateLimit | undefined;
  kv: KVNamespace | undefined;
  /** Unique key for this limit (e.g. `meta-events:<ip>`). */
  key: string;
  /** Max requests per window; the native binding uses its configured limit. */
  limit: number;
  windowMs?: number;
}

/** Returns true when the request is within the limit. */
export async function enforceRateLimit(options: EnforceRateLimitOptions): Promise<boolean> {
  if (options.limiter) {
    return (await options.limiter.limit({ key: options.key })).success;
  }
  if (!options.kv) return true;
  return (await rateLimit({
    kv: options.kv,
    key: options.key,
    limit: options.limit,
    windowMs: options.windowMs ?? 60_000,
  })).allowed;
}
