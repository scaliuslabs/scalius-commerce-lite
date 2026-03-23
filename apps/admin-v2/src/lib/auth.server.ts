/**
 * Server-only auth helpers for TanStack Start.
 *
 * Isolates cloudflare:workers import so it cannot leak into client bundles.
 * Only import this file inside .server() callbacks or other .server.ts files.
 */

import { createAuth } from "@scalius/core/auth";
import { getDb } from "@scalius/database/client";
import { initKv } from "@scalius/core/utils/kv-cache";
import { initStorage } from "@scalius/core/integrations/storage";
import { env as cfEnv } from "cloudflare:workers";

/**
 * Access Cloudflare env bindings.
 */
function getCfEnv(): Env {
  return cfEnv;
}

/**
 * Initialize Cloudflare bindings (DB, KV, Storage).
 * Called once per request in the auth middleware.
 */
export function initBindings(): Env {
  const env = getCfEnv();

  // Initialize DB
  getDb(env);

  // Initialize KV cache if available
  if (env.CACHE) initKv(env.CACHE);

  // Initialize R2 storage if available
  if (env.BUCKET) {
    initStorage(env.BUCKET, (env.R2_PUBLIC_URL as string) || "");
  }

  return env;
}

/**
 * Extract Better Auth session from request headers.
 * Uses admin-v2's own Better Auth which shares D1 with the API worker.
 * Returns { user, session } or null if no valid session.
 */
export async function getAuthSession(
  headers: Headers,
): Promise<{
  user: BetterAuthUser;
  session: BetterAuthSession;
} | null> {
  const env = getCfEnv();
  const auth = createAuth(env);

  try {
    const result = await auth.api.getSession({ headers });
    if (result?.session && result?.user) {
      return {
        user: result.user as BetterAuthUser,
        session: result.session as BetterAuthSession,
      };
    }
  } catch (error) {
    console.error("Error getting auth session:", error);
  }

  return null;
}

/**
 * Create a Better Auth handler for the catch-all API route.
 * Returns the auth.handler function bound to the current env.
 */
export function createAuthHandler(): (request: Request) => Promise<Response> {
  const env = getCfEnv();
  const auth = createAuth(env);
  return (request: Request) => auth.handler(request);
}
