/**
 * Shared Cloudflare environment detection utility.
 *
 * CF Worker env objects are Proxy objects where Object.keys() returns [].
 * We must probe known properties to detect if we're running in a CF Worker.
 */
import { env as cfEnv } from "cloudflare:workers";

/** Returns the Cloudflare Env if running in a Worker, otherwise undefined. */
export function getCfEnv(): Env | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cloudflare env is a Proxy; property detection requires any
    const e = cfEnv as any;
    if (e?.ASSETS || e?.DB || e?.PUBLIC_API_BASE_URL || e?.API) {
      return cfEnv as unknown as Env;
    }
  } catch {
    // Not in CF Worker context
  }
  return undefined;
}

/** Returns the Cloudflare Env if available, otherwise falls back to process.env. */
export function getEnvWithFallback(): Env {
  const env = getCfEnv();
  if (env) return env;
  if (typeof process !== "undefined") return process.env as unknown as Env;
  return {} as Env;
}
