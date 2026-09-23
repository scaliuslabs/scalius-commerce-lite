// Two native Workers Rate Limiting namespaces (apps/api/wrangler*.jsonc):
//   RL_STRICT   5/60s  phone-bearing or abuse-prone writes (checkout phone)
//   RL_STANDARD 60/60s everything else (search, checkout IP, abandoned
//                      checkout, Meta browser events, agent access)
// A namespace's counters are shared by every Worker in the Cloudflare account
// that binds the same namespace_id, and the hosted platform packs many stores
// into one account, so every key is scoped to this store and the purpose.
import { ServiceUnavailableError } from "./api-error";

export type RateLimitTier = "RL_STRICT" | "RL_STANDARD";

/** This store's public API host, resolved from Platform settings at Worker entry. */
function storeScope(env: Env): string {
  try {
    return new URL(env.PUBLIC_API_BASE_URL ?? "").hostname.toLowerCase();
  } catch {
    return "unconfigured";
  }
}

/** Store-scoped limiter key. Hashed so phone numbers and IPs never reach the limiter in clear. */
export async function rateLimitKey(env: Env, purpose: string, subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${storeScope(env)}\0${purpose}\0${subject}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Returns true when the request is within the limit; fails closed without the binding. */
export async function isWithinRateLimit(
  env: Env,
  tier: RateLimitTier,
  purpose: string,
  subject: string,
): Promise<boolean> {
  const limiter = env[tier];
  if (!limiter) throw new ServiceUnavailableError("Rate limiting is unavailable");
  return (await limiter.limit({ key: await rateLimitKey(env, purpose, subject) })).success;
}
