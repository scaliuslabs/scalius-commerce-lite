/**
 * Dashboard sign-in surface: `<dashboard>/api/auth/*`.
 *
 * Better Auth (sign-in, 2FA, sessions, password reset, identity handoff) runs
 * here on the dashboard hostname so its cookies stay first-party to the
 * dashboard origin. The static SPA reads its route-guard state from
 * `GET /api/auth/dashboard-session`.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { createAuth } from "@scalius/core/auth";
import { adminPrincipalExists } from "@scalius/core/auth/admin-setup";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { isTransientD1Error, retryTransientD1, wait } from "@scalius/core/utils/transient-d1";
import { getDb } from "@scalius/database/client";
import { adminInvitations, session as sessionTable, user as userTable, verification } from "@scalius/database/schema";
import { getAdminSessionFromCookieHeader, getAdminSessionTokenFromCookieHeader } from "../middleware/admin-auth";
import { isForeignDashboardRequest } from "../middleware/cookie-origin-guard";

const AUTH_RETRY_DELAYS_MS = [200, 500, 1000] as const;
const NO_STORE = "private, no-store, max-age=0, must-revalidate";

const SESSION_STATE_PATH = "/api/auth/dashboard-session";
const RESET_SESSION_PATH = "/api/auth/reset-session";
const RESET_PASSWORD_SESSION_PATH = "/api/auth/reset-password-session";
const SIGN_IN_EMAIL_PATH = "/api/auth/sign-in/email";
const TWO_FACTOR_VERIFY_PATHS = new Set([
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-otp",
  "/api/auth/two-factor/verify-backup-code",
]);
/** Account creation, password changes and 2FA removal go through the admin API. */
const BLOCKED_PATHS = new Set([
  "/api/auth/sign-up/email",
  "/api/auth/change-password",
  "/api/auth/reset-password",
  "/api/auth/two-factor/disable",
]);

const RESET_SESSION_COOKIE = "__Host-scalius-password-reset";
const RESET_SESSION_MAX_AGE_SECONDS = 10 * 60;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": NO_STORE, ...headers } });
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", NO_STORE);
  headers.set("Pragma", "no-cache");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function resetSessionCookie(value: string, maxAge: number): string {
  return `${RESET_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.clone().json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// ── Route-guard state for the static dashboard ───────────────────────────────

export interface DashboardSessionState {
  adminExists: boolean;
  signIn: { localLoginDisabled: boolean; identityHandoffEnabled: boolean };
  session: null | {
    user: {
      id: string;
      name: string;
      email: string;
      image: string | null;
      role: string | null;
      twoFactorEnabled: boolean;
      mustChangePassword: boolean;
      mustEnrollTwoFactor: boolean;
      isSuperAdmin: boolean;
    };
    twoFactorVerified: boolean;
    /** Present only once every sign-in gate has passed. */
    permissions: string[] | null;
  };
  /**
   * No session, but this browser still holds a signed one that someone else
   * ended (suspended, removed, or signed out from another device): the
   * sign-in page says so. Never set by the person's own sign-out, which
   * clears the cookie, nor by a session that simply expired.
   */
  signedOut?: "access_changed";
}

/**
 * Whether the browser's signed session cookie names a session that was
 * deleted, or whose person was suspended, rather than one that ran out.
 * The cookie's signature proves this browser was signed in; nothing about
 * any other account is revealed.
 */
async function sessionEndedByAccessChange(db: ReturnType<typeof getDb>, request: Request, env: Env): Promise<boolean> {
  const token = await getAdminSessionTokenFromCookieHeader(request.headers.get("cookie") ?? undefined, env.BETTER_AUTH_SECRET);
  if (!token) return false;
  const row = await retryTransientD1(() =>
    db
      .select({ expiresAt: sessionTable.expiresAt })
      .from(sessionTable)
      .where(eq(sessionTable.token, token))
      .get(),
  );
  return !row || row.expiresAt.getTime() > Date.now();
}

/** Everything the dashboard route guards decide from, in one read. */
export async function readDashboardSessionState(
  request: Request,
  env: Env,
): Promise<DashboardSessionState> {
  const db = getDb(env);
  const handoff = env.PLATFORM_CONFIG?.identityHandoff;
  const signIn = {
    localLoginDisabled: handoff?.localLoginDisabled === true,
    identityHandoffEnabled: handoff?.enabled === true,
  };
  const found = await getAdminSessionFromCookieHeader(
    db,
    request.headers.get("cookie") ?? undefined,
    env.BETTER_AUTH_SECRET,
  );
  if (!found) {
    const [adminExists, accessChanged] = await Promise.all([
      // A failed read keeps the sign-in form: never offer setup on a guess.
      retryTransientD1(() => adminPrincipalExists(db)).catch(() => true),
      sessionEndedByAccessChange(db, request, env).catch(() => false),
    ]);
    return { adminExists, signIn, session: null, ...(accessChanged ? { signedOut: "access_changed" as const } : {}) };
  }

  const { user, session } = found;
  const twoFactorEnabled = user.twoFactorEnabled === true;
  const twoFactorVerified = session.twoFactorVerified === true;
  const isSuperAdmin = user.isSuperAdmin === true;
  const passedGates =
    user.mustChangePassword !== true &&
    !(user.mustEnrollTwoFactor === true && !twoFactorEnabled) &&
    (!twoFactorEnabled || twoFactorVerified);
  const permissions = passedGates
    ? [...await retryTransientD1(() => getUserPermissions(db, user.id, env.CACHE, isSuperAdmin))]
    : null;

  return {
    adminExists: true,
    signIn,
    session: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image ?? null,
        role: user.role ?? null,
        twoFactorEnabled,
        mustChangePassword: user.mustChangePassword === true,
        mustEnrollTwoFactor: user.mustEnrollTwoFactor === true,
        isSuperAdmin,
      },
      twoFactorVerified,
      permissions,
    },
  };
}

// ── Password reset and staff invites without the token in a URL ─────────────

const RESET_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

const USED_RESET_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Better Auth deletes a reset or invite token when it is used. A hash of it is
 * kept (under the person's `reset-password:` rows, so a newer link or removing
 * the person clears it) to tell "already used" from "expired": the token is
 * the proof, so saying so reveals nothing about any email address.
 */
async function usedResetTokenIdentifier(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `reset-password:used:${hex}`;
}

async function isUsedResetToken(env: Env, token: string): Promise<boolean> {
  const identifier = await usedResetTokenIdentifier(token);
  const row = await retryTransientD1(() =>
    getDb(env)
      .select({ id: verification.id })
      .from(verification)
      .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, new Date())))
      .get(),
  );
  return Boolean(row);
}

async function rememberUsedResetToken(env: Env, token: string, userId: string): Promise<void> {
  const now = new Date();
  try {
    await retryTransientD1(async () => getDb(env).insert(verification).values({
      id: crypto.randomUUID(),
      identifier: await usedResetTokenIdentifier(token),
      value: userId,
      expiresAt: new Date(now.getTime() + USED_RESET_TOKEN_TTL_MS),
      createdAt: now,
      updatedAt: now,
    }));
  } catch {
    // Only the wording of a reopened link depends on it; the password is set.
    console.warn("Could not record a used reset link");
  }
}

/** The person behind a live reset or invite token, or null when it is used, replaced or expired. */
async function readResetToken(env: Env, token: string) {
  const db = getDb(env);
  return retryTransientD1(() =>
    db
      .select({
        userId: userTable.id,
        email: userTable.email,
        invite: sql<number>`${userTable.mustChangePassword} = 1 AND ${adminInvitations.status} = 'pending'`,
      })
      .from(verification)
      .innerJoin(userTable, eq(userTable.id, verification.value))
      .leftJoin(adminInvitations, eq(adminInvitations.userId, userTable.id))
      .where(and(
        eq(verification.identifier, `reset-password:${token}`),
        gt(verification.expiresAt, new Date()),
      ))
      .get(),
  );
}

/**
 * Checks the link when the page opens, so a used or expired link never shows
 * the password form, and says whether it is a staff invite.
 */
async function createResetSession(request: Request, env: Env): Promise<Response> {
  const token = (await readJson(request)).token;
  const wellFormed = typeof token === "string" && RESET_TOKEN_SHAPE.test(token);
  const live = wellFormed ? await readResetToken(env, token) : null;
  if (!live) {
    return wellFormed && await isUsedResetToken(env, token)
      ? json({ code: "TOKEN_USED", message: "This link was already used. Sign in instead." }, 400)
      : json({ code: "INVALID_TOKEN", message: "This link has expired or was already used." }, 400);
  }
  return json({ status: true, purpose: live.invite ? "invite" : "reset" }, 200, {
    "Set-Cookie": resetSessionCookie(token as string, RESET_SESSION_MAX_AGE_SECONDS),
  });
}

/**
 * Sets the new password, then signs the person in with it so they continue
 * straight to two-step verification (or its first-time setup) instead of
 * typing the password again.
 */
async function resetPasswordFromSession(
  auth: ReturnType<typeof createAuth>,
  env: Env,
  request: Request,
  basePath: string,
): Promise<Response> {
  const token = readCookie(request, RESET_SESSION_COOKIE);
  const newPassword = (await readJson(request)).newPassword;
  const clearCookie = resetSessionCookie("", 0);
  const account = token && RESET_TOKEN_SHAPE.test(token) ? await readResetToken(env, token) : null;
  if (!token || !account || typeof newPassword !== "string") {
    return json(
      { code: "INVALID_TOKEN", message: "This link has expired or was already used." },
      400,
      { "Set-Cookie": clearCookie },
    );
  }

  const authRequest = (path: string, body: Record<string, unknown>) => {
    const target = new URL(request.url);
    target.pathname = `${basePath}/api/auth/${path}`;
    target.search = "";
    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Length");
    headers.delete("Cookie");
    return new Request(target, { method: "POST", headers, body: JSON.stringify(body) });
  };

  const reset = await auth.handler(authRequest("reset-password", { newPassword, token }));
  if (!reset.ok) {
    const headers = new Headers(reset.headers);
    headers.append("Set-Cookie", clearCookie);
    return new Response(reset.body, { status: reset.status, headers });
  }
  await rememberUsedResetToken(env, token, account.userId);

  const signInRequest = authRequest("sign-in/email", { email: account.email, password: newPassword, rememberMe: true });
  const signIn = await preferConfiguredTwoFactorMethod(env, signInRequest, await auth.handler(signInRequest.clone() as Request));
  const headers = new Headers({ "Cache-Control": NO_STORE });
  headers.append("Set-Cookie", clearCookie);
  if (!signIn.ok) {
    // The password is set; the person signs in on the form instead.
    return Response.json({ status: true, signedIn: false }, { headers });
  }
  for (const cookie of signIn.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  const result = await signIn.json() as { twoFactorRedirect?: boolean; twoFactorMethods?: unknown[] };
  if (result.twoFactorRedirect === true) {
    return Response.json(
      { status: true, signedIn: false, twoFactorRedirect: true, twoFactorMethods: result.twoFactorMethods ?? [] },
      { headers },
    );
  }
  const backupCodes = await startRequiredTwoFactorSetup(auth, env, account.userId, newPassword, signIn);
  return Response.json(
    { status: true, signedIn: true, ...(backupCodes ? { twoFactorSetup: { backupCodes } } : {}) },
    { headers },
  );
}

/**
 * First-time two-step setup, when the store requires it. The password was
 * proven a moment ago in this same request (fresher than Better Auth's
 * fresh-session rule for sensitive actions), so the authenticator enrolment
 * that asks for it starts here rather than asking again on the next page.
 * Returns the backup codes the setup page shows once the email code is
 * confirmed, or null to fall back to that page's password step.
 */
async function startRequiredTwoFactorSetup(
  auth: ReturnType<typeof createAuth>,
  env: Env,
  userId: string,
  password: string,
  signIn: Response,
): Promise<string[] | null> {
  try {
    const person = await retryTransientD1(() =>
      getDb(env)
        .select({ mustEnroll: userTable.mustEnrollTwoFactor, enabled: userTable.twoFactorEnabled })
        .from(userTable)
        .where(eq(userTable.id, userId))
        .get(),
    );
    if (person?.mustEnroll !== true || person.enabled === true) return null;
    const cookie = signIn.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
    const enabled = await auth.api.enableTwoFactor({ headers: new Headers({ cookie }), body: { password, method: "totp" } });
    return "backupCodes" in enabled ? enabled.backupCodes : null;
  } catch {
    return null;
  }
}

// ── Better Auth with D1 retries and dashboard 2FA bookkeeping ────────────────

/**
 * Sign-in and reads retry transient D1 failures. A sign-in that still fails
 * answers a retryable 503 instead of a misleading credential error.
 */
async function runWithRetry(
  handler: (request: Request) => Promise<Response>,
  request: Request,
  isSignIn: boolean,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!isSignIn && method !== "GET" && method !== "HEAD") return handler(request);

  const attempts = AUTH_RETRY_DELAYS_MS.length + 1;
  const copies = Array.from({ length: attempts }, () => request.clone() as Request);
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await handler(copies[attempt]!);
      if (response.status < 500) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
      if (!isSignIn && !isTransientD1Error(error)) throw error;
    }
    const delayMs = AUTH_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    console.warn("Dashboard auth hit a retryable failure; retrying", {
      status: lastResponse?.status,
      attempt: attempt + 1,
    });
    await wait(delayMs);
  }

  if (isSignIn) {
    return json(
      {
        code: "TEMPORARY_AUTH_BACKEND_UNAVAILABLE",
        message: "Authentication is temporarily unavailable. Please retry in a moment.",
      },
      503,
      { "Retry-After": "2" },
    );
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}

/** Offer the administrator's saved 2FA method first after a password step. */
async function preferConfiguredTwoFactorMethod(
  env: Env,
  request: Request,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  try {
    const body = await response.clone().json() as Record<string, unknown>;
    if (body.twoFactorRedirect !== true || !Array.isArray(body.twoFactorMethods)) return response;
    const email = (await readJson(request)).email;
    if (typeof email !== "string") return response;

    const preference = await getDb(env)
      .select({ method: userTable.twoFactorMethod })
      .from(userTable)
      .where(eq(userTable.email, email.trim().toLowerCase()))
      .get();
    const preferred = preference?.method === "email" ? "otp" : preference?.method === "totp" ? "totp" : null;
    const methods = body.twoFactorMethods as unknown[];
    if (!preferred || methods.indexOf(preferred) <= 0) return response;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return Response.json(
      { ...body, twoFactorMethods: [preferred, ...methods.filter((method) => method !== preferred)] },
      { status: response.status, headers },
    );
  } catch {
    return response;
  }
}

/** A verified second factor marks the new session; the admin API requires it. */
async function markTwoFactorVerified(env: Env, response: Response): Promise<void> {
  if (!response.ok) return;
  let proof: { token?: unknown; user?: { id?: unknown } };
  try {
    proof = await response.clone().json() as typeof proof;
  } catch {
    return;
  }
  const token = proof.token;
  const userId = proof.user?.id;
  if (typeof token !== "string" || typeof userId !== "string") return;

  const db = getDb(env);
  await retryTransientD1(
    () => db
      .update(sessionTable)
      .set({ twoFactorVerified: true, updatedAt: new Date() })
      .where(and(eq(sessionTable.token, token), eq(sessionTable.userId, userId))),
    { delaysMs: AUTH_RETRY_DELAYS_MS },
  );
}

/**
 * Handles one `<basePath>/api/auth/*` request. `path` is the request path with
 * the dashboard base path removed; Better Auth itself sees the full path
 * because its own `basePath` carries the prefix.
 */
export async function handleDashboardAuthRequest(
  request: Request,
  env: Env,
  path: string,
  basePath: string,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const route = path.replace(/\/+$/, "");

  // Only dashboard pages may call sign-in routes (top-level navigations such
  // as the identity handoff carry no Origin and pass).
  if (isForeignDashboardRequest(request, env.BETTER_AUTH_URL)) {
    return json({ success: false, error: "Cross-origin dashboard request denied" }, 403);
  }
  if (route === SESSION_STATE_PATH) {
    if (method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);
    return json(await readDashboardSessionState(request, env));
  }
  if (method === "POST" && route === RESET_SESSION_PATH) return createResetSession(request, env);

  // Fresh stores have no Dashboard URL yet: the first admin signs in on the
  // origin they reached, then configures it under Settings -> Platform.
  const authEnv: Env = {
    ...env,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL || new URL(request.url).origin,
  };
  const auth = createAuth(authEnv);

  if (method === "POST" && route === RESET_PASSWORD_SESSION_PATH) {
    return withNoStore(await resetPasswordFromSession(auth, authEnv, request, basePath));
  }
  if (BLOCKED_PATHS.has(route) || route === "/api/auth/admin" || route.startsWith("/api/auth/admin/")) {
    return json({ code: "AUTH_ROUTE_NOT_AVAILABLE", message: "This authentication operation is not available." }, 403);
  }
  const verifiesSecondFactor = method === "POST" && TWO_FACTOR_VERIFY_PATHS.has(route);
  if (verifiesSecondFactor && (await readJson(request)).trustDevice === true) {
    return json({ code: "TRUSTED_DEVICE_DISABLED", message: "Trusted-device 2FA verification is not enabled." }, 400);
  }

  const isSignIn = method === "POST" && route === SIGN_IN_EMAIL_PATH;
  let response = await runWithRetry((attempt) => auth.handler(attempt), request, isSignIn);
  if (isSignIn) response = await preferConfiguredTwoFactorMethod(authEnv, request, response);
  if (verifiesSecondFactor) await markTwoFactorVerified(authEnv, response);
  return withNoStore(response);
}
