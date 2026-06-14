/**
 * Server-only auth helpers for TanStack Start.
 *
 * Isolates cloudflare:workers import so it cannot leak into client bundles.
 * Only import this file inside .server() callbacks or other .server.ts files.
 */

import { createAuth } from "@scalius/core/auth";
import { isTransientD1Error, retryTransientD1, wait } from "@scalius/core/utils/transient-d1";
import { getDb } from "@scalius/database/client";
import { initKv } from "@scalius/core/utils/kv-cache";
import { initStorage } from "@scalius/core/integrations/storage";
import { env as cfEnv } from "cloudflare:workers";

const AUTH_RETRY_DELAYS_MS = [200, 500, 1000] as const;

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
    const result = await retryTransientD1(
      () => auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      }),
      {
        delaysMs: AUTH_RETRY_DELAYS_MS,
        onRetry: (error, attempt, delayMs) => {
          console.warn("Auth session lookup hit transient D1 error; retrying", {
            attempt: attempt + 1,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
    );
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

function isRetryableAuthRequest(request: Request): boolean {
  const method = request.method.toUpperCase();
  return method === "GET" || method === "HEAD";
}

function isSignInEmailRequest(request: Request): boolean {
  return (
    request.method.toUpperCase() === "POST" &&
    new URL(request.url).pathname.endsWith("/api/auth/sign-in/email")
  );
}

const TWO_FACTOR_VERIFY_PATH_SUFFIXES = [
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-otp",
  "/api/auth/two-factor/verify-backup-code",
] as const;

async function readsTrustedDeviceRequest(request: Request): Promise<boolean> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return false;

  try {
    const body = (await request.clone().json()) as { trustDevice?: unknown };
    return body.trustDevice === true;
  } catch {
    return false;
  }
}

export async function shouldRejectTrustedDeviceVerificationRequest(
  request: Request,
): Promise<boolean> {
  if (request.method.toUpperCase() !== "POST") return false;
  const pathname = new URL(request.url).pathname;
  if (!TWO_FACTOR_VERIFY_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
    return false;
  }

  return readsTrustedDeviceRequest(request);
}

function trustedDeviceDisabledResponse(): Response {
  return Response.json(
    {
      code: "TRUSTED_DEVICE_DISABLED",
      message: "Trusted-device 2FA verification is not enabled.",
    },
    {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function temporaryAuthFailureResponse(): Response {
  return Response.json(
    {
      code: "TEMPORARY_AUTH_BACKEND_UNAVAILABLE",
      message: "Authentication is temporarily unavailable. Please retry in a moment.",
    },
    {
      status: 503,
      headers: {
        "Retry-After": "2",
        "Cache-Control": "no-store",
      },
    },
  );
}

async function runSignInEmailWithRetry(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const attempts = Array.from(
    { length: AUTH_RETRY_DELAYS_MS.length + 1 },
    () => request.clone(),
  );
  let lastResponse: Response | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    try {
      const response = await handler(attempts[attempt] ?? request.clone());
      if (response.status < 500) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }

    const delayMs = AUTH_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) break;

    console.warn("Auth sign-in hit a retryable server failure; retrying", {
      status: lastResponse?.status,
      attempt: attempt + 1,
      delayMs,
      error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined,
    });
    await wait(delayMs);
  }

  console.warn("Auth sign-in failed after retries; surfacing retryable failure", {
    status: lastResponse?.status,
    error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined,
    transient: lastError ? isTransientD1Error(lastError) : undefined,
  });
  return temporaryAuthFailureResponse();
}

async function runAuthHandlerWithRetry(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  if (isSignInEmailRequest(request)) {
    return runSignInEmailWithRetry(handler, request);
  }

  if (!isRetryableAuthRequest(request)) {
    return handler(request);
  }

  const attempts = Array.from(
    { length: AUTH_RETRY_DELAYS_MS.length + 1 },
    () => request.clone(),
  );
  let lastResponse: Response | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    try {
      const response = await handler(attempts[attempt] ?? request.clone());
      if (response.status < 500 || attempt === attempts.length - 1) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
      if (!isTransientD1Error(error) || attempt === attempts.length - 1) {
        throw error;
      }
    }

    const delayMs = AUTH_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    console.warn("Auth handler hit a retryable transient failure; retrying", {
      method: request.method,
      pathname: new URL(request.url).pathname,
      status: lastResponse?.status,
      attempt: attempt + 1,
      delayMs,
      error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined,
    });
    await wait(delayMs);
  }

  if (lastResponse) return lastResponse;
  throw lastError;
}

/**
 * Create a Better Auth handler for the catch-all API route.
 * Returns the auth.handler function bound to the current env.
 */
export function createAuthHandler(): (request: Request) => Promise<Response> {
  const env = getCfEnv();
  const auth = createAuth(env);
  return async (request: Request) => {
    if (await shouldRejectTrustedDeviceVerificationRequest(request)) {
      return trustedDeviceDisabledResponse();
    }

    return runAuthHandlerWithRetry((retryRequest) => auth.handler(retryRequest), request);
  };
}
