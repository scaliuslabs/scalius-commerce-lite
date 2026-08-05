/**
 * Server-only auth helpers for TanStack Start.
 *
 * Isolates cloudflare:workers import so it cannot leak into client bundles.
 * Only import this file inside .server() callbacks or other .server.ts files.
 */

import { createAuth } from "@scalius/core/auth";
import { isTransientD1Error, retryTransientD1, wait } from "@scalius/core/utils/transient-d1";
import { getDb } from "@scalius/database/client";
import { session as sessionTable } from "@scalius/database/schema";
import { env as cfEnv } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";

const AUTH_RETRY_DELAYS_MS = [200, 500, 1000] as const;

/**
 * Access Cloudflare env bindings.
 */
function getCfEnv(): Env {
  return cfEnv;
}

/**
 * Validate the request-scoped database binding.
 * Called once per request in the auth middleware.
 */
export function initBindings(): Env {
  const env = getCfEnv();

  getDb(env);
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

const BLOCKED_PUBLIC_AUTH_PATH_SUFFIXES = [
  "/api/auth/sign-up/email",
  "/api/auth/change-password",
  "/api/auth/reset-password",
  "/api/auth/two-factor/disable",
] as const;
const RESET_SESSION_COOKIE = "__Host-scalius-password-reset";
const RESET_SESSION_PATH = "/api/auth/reset-session";
const RESET_PASSWORD_SESSION_PATH = "/api/auth/reset-password-session";
const RESET_SESSION_MAX_AGE_SECONDS = 10 * 60;

function resetSessionCookie(value: string, maxAge: number): string {
  return `${RESET_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function createResetSession(request: Request): Promise<Response> {
  let token: unknown;
  try {
    token = ((await request.json()) as { token?: unknown }).token;
  } catch {
    token = null;
  }
  if (
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    return Response.json(
      { code: "INVALID_RESET_SESSION", message: "This reset link is invalid." },
      { status: 400 },
    );
  }
  return Response.json(
    { status: true },
    {
      headers: {
        "Set-Cookie": resetSessionCookie(token, RESET_SESSION_MAX_AGE_SECONDS),
      },
    },
  );
}

async function resetPasswordFromSession(
  authHandler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const token = readCookie(request, RESET_SESSION_COOKIE);
  let newPassword: unknown;
  try {
    newPassword = ((await request.clone().json()) as { newPassword?: unknown }).newPassword;
  } catch {
    newPassword = null;
  }
  if (!token || typeof newPassword !== "string") {
    return Response.json(
      { code: "INVALID_RESET_SESSION", message: "This reset link is invalid or expired." },
      {
        status: 400,
        headers: { "Set-Cookie": resetSessionCookie("", 0) },
      },
    );
  }

  const target = new URL(request.url);
  target.pathname = "/api/auth/reset-password";
  target.search = "";
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  headers.delete("Cookie");
  const response = await authHandler(new Request(target, {
    method: "POST",
    headers,
    body: JSON.stringify({ newPassword, token }),
  }));
  const responseHeaders = new Headers(response.headers);
  responseHeaders.append("Set-Cookie", resetSessionCookie("", 0));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export function shouldRejectPublicAuthRoute(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    BLOCKED_PUBLIC_AUTH_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix)) ||
    pathname === "/api/auth/admin" ||
    pathname.startsWith("/api/auth/admin/")
  );
}

function publicAuthRouteDeniedResponse(): Response {
  return Response.json(
    {
      code: "AUTH_ROUTE_NOT_AVAILABLE",
      message: "This authentication operation is not available.",
    },
    { status: 403 },
  );
}

function applyAuthNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function markSuccessfulTwoFactorVerification(
  env: Env,
  request: Request,
  response: Response,
): Promise<void> {
  if (!response.ok) return;
  const pathname = new URL(request.url).pathname;
  if (!TWO_FACTOR_VERIFY_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
    return;
  }

  let proof: { token?: unknown; user?: { id?: unknown } };
  try {
    proof = await response.clone().json() as typeof proof;
  } catch {
    return;
  }
  if (typeof proof.token !== "string" || typeof proof.user?.id !== "string") {
    return;
  }

  const db = getDb(env);
  await retryTransientD1(
    () => db
      .update(sessionTable)
      .set({ twoFactorVerified: true, updatedAt: new Date() })
      .where(and(
        eq(sessionTable.token, proof.token as string),
        eq(sessionTable.userId, proof.user!.id as string),
      )),
    { delaysMs: AUTH_RETRY_DELAYS_MS },
  );
}

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
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === RESET_SESSION_PATH) {
      return applyAuthNoStore(await createResetSession(request));
    }
    if (request.method === "POST" && pathname === RESET_PASSWORD_SESSION_PATH) {
      const response = await resetPasswordFromSession(
        (resetRequest) => auth.handler(resetRequest),
        request,
      );
      return applyAuthNoStore(response);
    }
    if (shouldRejectPublicAuthRoute(request)) {
      return applyAuthNoStore(publicAuthRouteDeniedResponse());
    }
    if (await shouldRejectTrustedDeviceVerificationRequest(request)) {
      return applyAuthNoStore(trustedDeviceDisabledResponse());
    }

    const response = await runAuthHandlerWithRetry(
      (retryRequest) => auth.handler(retryRequest),
      request,
    );
    await markSuccessfulTwoFactorVerification(env, request, response);
    return applyAuthNoStore(response);
  };
}
