import { trimTrailingCharacter } from "@scalius/shared/text-scan";
/**
 * Dashboard sign-in surface: `<dashboard>/api/auth/*`.
 *
 * Better Auth (sign-in, 2FA, sessions, password reset, identity handoff) runs
 * here on the dashboard hostname so its cookies stay first-party to the
 * dashboard origin. The static SPA reads its route-guard state from
 * `GET /api/auth/dashboard-session`.
 */
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { pendingAdminAuthStep } from "@scalius/shared/admin-auth-step";
import { createAuth, twoFactorMethodsForAccount } from "@scalius/core/auth";
import { adminPrincipalExists } from "@scalius/core/auth/admin-setup";
import { readStoreName } from "@scalius/core/modules/notifications";
import { RESET_TOKEN_MARKER_TTL_MS, resetTokenMarkerIdentifier } from "@scalius/core/auth/reset-token-markers";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { isTransientD1Error, retryTransientD1, wait } from "@scalius/core/utils/transient-d1";
import { getDb } from "@scalius/database/client";
import { account, adminInvitations, session as sessionTable, user as userTable, verification } from "@scalius/database/schema";
import { getAdminSessionFromCookieHeader, getAdminSessionTokenFromCookieHeader } from "../middleware/admin-auth";
import { isForeignDashboardRequest } from "../middleware/cookie-origin-guard";
import { detachedAppProviders } from "../plugins/providers/app-providers";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { RateLimitError } from "../utils/api-error";
import { isWithinRateLimit } from "../utils/rate-limit";
import { reserveStaffProof, staffProofs } from "../utils/staff-proofs";
import { STAFF_SIGN_IN_ATTEMPTS, reserveStaffAttempt, type StaffAttempt } from "@scalius/core/auth/staff-attempts";
import { STAFF_KNOWN_DEVICE_PURPOSE, deriveRuntimeSecret, readMasterSecret, type MasterSecretEnvironment } from "@scalius/shared/runtime-secrets";
import { hmacSha256Hex } from "@scalius/shared/hash";
import { getTrustedClientIpFromRequest } from "../utils/client-ip";
import { withEnvFields } from "../runtime/runtime-env";

const AUTH_RETRY_DELAYS_MS = [200, 500, 1000] as const;
const NO_STORE = "private, no-store, max-age=0, must-revalidate";

const SESSION_STATE_PATH = "/api/auth/dashboard-session";
const RESET_SESSION_PATH = "/api/auth/reset-session";
const RESET_PASSWORD_SESSION_PATH = "/api/auth/reset-password-session";
const SIGN_IN_EMAIL_PATH = "/api/auth/sign-in/email";
const TWO_FACTOR_PATH_PREFIX = "/api/auth/two-factor/";
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
   * No session, but this browser still holds a signed cookie, so the sign-in
   * page can say why. "suspended": the session is live but its person is
   * suspended. "session_ended": the session is gone or ran out (signed out
   * from another device, ended by the owner, the store's database replaced).
   * Never set by the person's own sign-out, which clears the cookie, nor for
   * a forged cookie or none. A revoked role keeps its session, so it never
   * lands here (the dashboard's no-access page says so).
   */
  signedOut?: DashboardSignedOutReason;
}

export type DashboardSignedOutReason = "session_ended" | "suspended";

/**
 * Why the browser's signed session cookie no longer opens a session, or null
 * when it carries none. The cookie's signature proves this browser was signed
 * in; nothing about any other account is revealed.
 */
async function signedOutReason(db: ReturnType<typeof getDb>, request: Request, env: Env): Promise<DashboardSignedOutReason | null> {
  const token = await getAdminSessionTokenFromCookieHeader(request.headers.get("cookie") ?? undefined, env.BETTER_AUTH_SECRET);
  if (!token) return null;
  const row = await retryTransientD1(() =>
    db
      .select({ expiresAt: sessionTable.expiresAt, banned: userTable.banned, banExpires: userTable.banExpires })
      .from(sessionTable)
      .leftJoin(userTable, eq(userTable.id, sessionTable.userId))
      .where(eq(sessionTable.token, token))
      .get(),
  );
  const now = Date.now();
  if (!row || row.expiresAt.getTime() <= now) return "session_ended";
  return row.banned === true && !(row.banExpires && row.banExpires.getTime() <= now) ? "suspended" : "session_ended";
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
    const [adminExists, signedOut] = await Promise.all([
      // A failed read keeps the sign-in form: never offer setup on a guess.
      retryTransientD1(() => adminPrincipalExists(db)).catch(() => true),
      signedOutReason(db, request, env).catch(() => null),
    ]);
    return { adminExists, signIn, session: null, ...(signedOut ? { signedOut } : {}) };
  }

  const { user, session } = found;
  const twoFactorEnabled = user.twoFactorEnabled === true;
  const twoFactorVerified = session.twoFactorVerified === true;
  const isSuperAdmin = user.isSuperAdmin === true;
  const passedGates = pendingAdminAuthStep(user, session) === null;
  const permissions = passedGates
    // Native pushes recheck this answer before display; a cached grant must never outlive revocation.
    ? [...await retryTransientD1(() => getUserPermissions(db, user.id, isSuperAdmin))]
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

/**
 * Why a link that no longer works stopped working: "used" (Better Auth deletes
 * a reset or invite token when it is used; a hash of it is kept under the
 * person's `reset-password:` rows, so a newer link or removing the person
 * clears it) or "cancelled" (the owner revoked the invite; see
 * `@scalius/core/auth/reset-token-markers`). The token is the proof, so saying
 * so reveals nothing about any email address. Anything else is "expired".
 */
async function deadResetTokenReason(env: Env, token: string): Promise<"used" | "cancelled" | null> {
  const [used, cancelled] = await Promise.all([
    resetTokenMarkerIdentifier("used", token),
    resetTokenMarkerIdentifier("cancelled", token),
  ]);
  const row = await retryTransientD1(() =>
    getDb(env)
      .select({ identifier: verification.identifier })
      .from(verification)
      .where(and(inArray(verification.identifier, [used, cancelled]), gt(verification.expiresAt, new Date())))
      .get(),
  );
  return !row ? null : row.identifier === used ? "used" : "cancelled";
}

async function rememberUsedResetToken(env: Env, token: string, userId: string): Promise<void> {
  const now = new Date();
  try {
    await retryTransientD1(async () => getDb(env).insert(verification).values({
      id: crypto.randomUUID(),
      identifier: await resetTokenMarkerIdentifier("used", token),
      value: userId,
      expiresAt: new Date(now.getTime() + RESET_TOKEN_MARKER_TTL_MS),
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
        invitedByUserId: adminInvitations.invitedByUserId,
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

async function readInviteDetails(env: Env, email: string, invitedByUserId: string | null) {
  const db = getDb(env);
  const [storeName, inviter] = await Promise.all([
    readStoreName(db),
    invitedByUserId
      ? retryTransientD1(() => db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, invitedByUserId)).get()).catch(() => undefined)
      : undefined,
  ]);
  return { email, storeName, inviterName: inviter?.name ?? null };
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
    const reason = wellFormed ? await deadResetTokenReason(env, token) : null;
    if (reason === "used") return json({ code: "TOKEN_USED", message: "This link was already used. Sign in instead." }, 400);
    if (reason === "cancelled") return json({ code: "TOKEN_CANCELLED", message: "This invite was cancelled." }, 400);
    return json({ code: "INVALID_TOKEN", message: "This link has expired." }, 400);
  }
  // An invite page names the store, who invited the person and the email being set up.
  const invite = live.invite ? await readInviteDetails(env, live.email, live.invitedByUserId) : null;
  return json({ status: true, purpose: live.invite ? "invite" : "reset", ...(invite ? { invite } : {}) }, 200, {
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
  const signIn = await offerAccountTwoFactorMethods(env, signInRequest, await auth.handler(signInRequest.clone() as Request));
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
    const proofs = await staffProofs(env, getDb(env), auth, userId);
    const enabled = await proofs.enableTwoFactor({ headers: new Headers({ cookie }), body: { password, method: "totp" } });
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

/**
 * After a password step, offer the account's own second-step methods, its
 * saved one first: the authenticator only while it is that method (an unused
 * key left from an earlier email enrolment is never offered).
 */
async function offerAccountTwoFactorMethods(
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
    const methods = body.twoFactorMethods as unknown[];
    const offered = twoFactorMethodsForAccount(methods, preference?.method);
    if (offered.length === methods.length && offered.every((entry, index) => entry === methods[index])) return response;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return Response.json(
      { ...body, twoFactorMethods: offered },
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

const SIGN_IN_NETWORK_LIMIT_PURPOSE = "staff-sign-in-network";
/** Set after a right password; the account's attempt budget never holds this browser out. */
const KNOWN_DEVICE_COOKIE = "__Host-scalius-staff-device";
/** Checked on the server from the signed issue time, whatever the browser keeps. */
const KNOWN_DEVICE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * The only Better Auth routes the dashboard writes to. Anything else that
 * checks a password or a code through Better Auth's router (`get-totp-uri`,
 * `generate-backup-codes`, `delete-user` ...) is refused, so no proof runs
 * outside the per-person budget.
 */
const TWO_FACTOR_ENABLE_PATH = "/api/auth/two-factor/enable";
const ROUTER_WRITE_PATHS = new Set([
  SIGN_IN_EMAIL_PATH,
  "/api/auth/sign-out",
  "/api/auth/request-password-reset",
  "/api/auth/handoff/revoke",
  TWO_FACTOR_ENABLE_PATH,
  "/api/auth/two-factor/send-otp",
  ...TWO_FACTOR_VERIFY_PATHS,
]);

function tooManyAttempts(waitSeconds = 60): Response {
  const wait = String(waitSeconds);
  // The wait rides the body too: Better Auth's client hands the page the body, not the headers.
  return json(
    { code: "RATE_LIMITED", message: "Too many attempts. Wait and try again.", retryAfterSeconds: waitSeconds },
    429,
    { "Retry-After": wait, "X-Retry-After": wait },
  );
}

/** The known-device key, derived from the master secret under its own label; none without it (no mark is issued or honoured). */
async function knownDeviceKey(env: Env): Promise<string | null> {
  const master = readMasterSecret(env as unknown as MasterSecretEnvironment);
  return master ? deriveRuntimeSecret(master, STAFF_KNOWN_DEVICE_PURPOSE) : null;
}

/** The staff account behind an email and its credential's current version (the stored password hash). */
async function credentialOf(env: Env, email: string): Promise<{ userId: string; version: string } | null> {
  const row = await getDb(env)
    .select({ userId: userTable.id, version: account.password })
    .from(userTable)
    .innerJoin(account, and(eq(account.userId, userTable.id), eq(account.providerId, "credential")))
    .where(eq(userTable.email, email))
    .get();
  return row?.version ? { userId: row.userId, version: row.version } : null;
}

function knownDeviceSignature(key: string, userId: string, issuedAt: number, version: string): Promise<string> {
  return hmacSha256Hex(key, `staff-known-device\0${userId}\0${issuedAt}\0${version}`);
}

/**
 * `v1.<userId>.<issuedAt>.<signature>`: the person, when the mark was issued,
 * and an HMAC over both and the credential's version. A password change (a new
 * hash) voids every mark issued before it; a mark older than its server-side
 * age, for another person, or forged, is no mark. Read only when presented.
 */
async function hasKnownDeviceMark(env: Env, request: Request, email: string, nowSeconds: number): Promise<boolean> {
  const presented = readCookie(request, KNOWN_DEVICE_COOKIE);
  const parts = presented?.split(".");
  if (!parts || parts.length !== 4 || parts[0] !== "v1") return false;
  const [, userId, issued, signature] = parts as [string, string, string, string];
  const issuedAt = Number(issued);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > KNOWN_DEVICE_MAX_AGE_SECONDS) return false;
  const key = await knownDeviceKey(env);
  if (!key) return false;
  const credential = await credentialOf(env, email);
  if (!credential || credential.userId !== userId) return false;
  return constantTimeEqual(signature, await knownDeviceSignature(key, userId, issuedAt, credential.version));
}

async function knownDeviceCookie(env: Env, email: string, nowSeconds: number): Promise<string | null> {
  const key = await knownDeviceKey(env);
  const credential = key ? await credentialOf(env, email) : null;
  if (!key || !credential) return null;
  const signature = await knownDeviceSignature(key, credential.userId, nowSeconds, credential.version);
  return `${KNOWN_DEVICE_COOKIE}=v1.${credential.userId}.${nowSeconds}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${KNOWN_DEVICE_MAX_AGE_SECONDS}`;
}

type SignInGate = { refused: Response } | { email: string | null; attempt: StaffAttempt | null };

/**
 * Dashboard sign-in, before Better Auth's own per-IP limit: the caller's
 * network spends the strict budget (5 a minute), and then, from a browser
 * without a valid known-device mark, the email reserves one of its 20 attempts
 * per 15 minutes in the database, atomically, before the password is checked.
 * Every email is counted alike, so the answer never tells staff from anyone
 * else; a right password gives the attempt back. A marked browser is never
 * held out, so an outsider's guesses cannot lock the owner out.
 */
async function gateSignIn(env: Env, request: Request): Promise<SignInGate> {
  if (!(await isWithinRateLimit(env, "RL_STRICT", SIGN_IN_NETWORK_LIMIT_PURPOSE, getTrustedClientIpFromRequest(request, env)))) {
    return { refused: tooManyAttempts() };
  }
  const raw = (await readJson(request)).email;
  const email = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
  if (!email) return { email: null, attempt: null };
  if (await hasKnownDeviceMark(env, request, email, Math.floor(Date.now() / 1000))) return { email, attempt: null };
  const attempt = await reserveStaffAttempt(getDb(env), STAFF_SIGN_IN_ATTEMPTS, email);
  if (attempt.waitSeconds !== null) return { refused: tooManyAttempts(attempt.waitSeconds) };
  return { email, attempt };
}

/**
 * Gives back the attempt of a right password, or of one never checked (Better
 * Auth refused it first), and marks the browser after a right one; a wrong
 * password keeps its attempt.
 */
async function settleSignIn(
  env: Env,
  gate: { email: string | null; attempt: StaffAttempt | null },
  response: Response,
  checked: boolean,
): Promise<Response> {
  if (!gate.email) return response;
  if (!checked) {
    await gate.attempt?.refund();
    return response;
  }
  if (!response.ok) return response;
  await gate.attempt?.refund();
  const mark = await knownDeviceCookie(env, gate.email, Math.floor(Date.now() / 1000));
  if (!mark) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", mark);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Better Auth's own limit answers 429 with only `X-Retry-After`: the standard
 * header carries the same wait, and so does the body (as our own refusals do),
 * since Better Auth's client hands the page the body, not the headers.
 */
async function withRetryAfter(response: Response): Promise<Response> {
  const wait = Number(response.headers.get("X-Retry-After"));
  if (response.status !== 429 || !(wait > 0) || response.headers.has("Retry-After")) return response;
  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(wait));
  headers.delete("Content-Length");
  // Read once: a clone would leave the original body unread.
  const body = await response.text().then((text) => JSON.parse(text) as unknown).catch(() => null);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return new Response(JSON.stringify({ ...fields, retryAfterSeconds: wait }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

type SessionHolder = NonNullable<Awaited<ReturnType<typeof getAdminSessionFromCookieHeader>>>;
type HolderLookup = { kind: "none" } | { kind: "dead"; cookieName: string } | { kind: "live"; holder: SessionHolder };

/**
 * The session behind Better Auth's own session cookie (only the name Better
 * Auth reads), from the database: a revoked session still answering from
 * Better Auth's 5-minute cookie cache is dead here.
 */
async function sessionHolder(env: Env, auth: ReturnType<typeof createAuth>, request: Request): Promise<HolderLookup> {
  const name = (await auth.$context).authCookies.sessionToken.name;
  const value = readCookie(request, name);
  if (value === null) return { kind: "none" };
  const holder = await getAdminSessionFromCookieHeader(getDb(env), `${name}=${encodeURIComponent(value)}`, env.BETTER_AUTH_SECRET);
  return holder ? { kind: "live", holder } : { kind: "dead", cookieName: name };
}

/**
 * The request without its dead session: the session token and Better Auth's
 * cached copy of it are dropped, so Better Auth answers as for a browser with
 * no session (a sign-in challenge still verifies through its own cookie).
 */
function withoutSessionCookies(request: Request): Request {
  const kept = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/(?:^|[.-])session_(?:token|data)=/.test(part.slice(0, part.indexOf("=") + 1)));
  const headers = new Headers(request.headers);
  if (kept.length) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");
  return new Request(request, { headers });
}

/** Reserves one of the person's in-session proof attempts; Better Auth's session path counts no failed codes. */
async function reserveSessionProof(env: Env, holder: SessionHolder): Promise<{ refused: Response } | { attempt: StaffAttempt }> {
  try {
    return { attempt: await reserveStaffProof(env, getDb(env), holder.user.id) };
  } catch (error) {
    if (error instanceof RateLimitError) return { refused: tooManyAttempts(error.retryAfterSeconds ?? 60) };
    throw error;
  }
}

/**
 * Turning two-step on through Better Auth (a first code on a session, or an
 * email-code enable) signs out every other session of the account: one taken
 * before it was on must sign in again with both factors. Better Auth replaced
 * the enabling session with the one its answer sets, which is kept.
 */
async function signOutOthersIfTwoStepTurnedOn(env: Env, holder: SessionHolder, response: Response): Promise<void> {
  if (!response.ok || holder.user.twoFactorEnabled) return;
  const db = getDb(env);
  const now = await db.select({ enabled: userTable.twoFactorEnabled }).from(userTable).where(eq(userTable.id, holder.user.id)).get();
  if (now?.enabled !== true) return;
  const setCookies = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const kept = await getAdminSessionTokenFromCookieHeader(setCookies, env.BETTER_AUTH_SECRET);
  await retryTransientD1(
    () => db.delete(sessionTable).where(and(
      eq(sessionTable.userId, holder.user.id),
      kept ? ne(sessionTable.token, kept) : ne(sessionTable.id, holder.session.id),
    )),
    { delaysMs: AUTH_RETRY_DELAYS_MS },
  );
}

const notAvailable = () => json({ code: "AUTH_ROUTE_NOT_AVAILABLE", message: "This authentication operation is not available." }, 403);

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
  const route = trimTrailingCharacter(path, "/");

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
  const authEnv = withEnvFields(env, {
    BETTER_AUTH_URL: env.BETTER_AUTH_URL || new URL(request.url).origin,
  });
  // Staff email (reset links, sign-in codes) may go through an app sender the
  // merchant chose; this handler has no Hono request, so on a detached context.
  const auth = createAuth(authEnv, {
    appProviders: detachedAppProviders(authEnv, getDb(authEnv), getCredentialEncryptionKey(authEnv as unknown as Record<string, unknown>)),
  });

  if (method === "POST" && route === RESET_PASSWORD_SESSION_PATH) {
    return withNoStore(await resetPasswordFromSession(auth, authEnv, request, basePath));
  }
  if (BLOCKED_PATHS.has(route) || route === "/api/auth/admin" || route.startsWith("/api/auth/admin/")) return notAvailable();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (!ROUTER_WRITE_PATHS.has(route)) return notAvailable();
    // The limits below read the JSON body; a form body would slip past them.
    const contentType = request.headers.get("content-type");
    if (contentType && !/^application\/json\s*(;|$)/i.test(contentType.trim())) {
      return json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this request as JSON." }, 415);
    }
  }
  const verifiesSecondFactor = method === "POST" && TWO_FACTOR_VERIFY_PATHS.has(route);
  if (verifiesSecondFactor && (await readJson(request)).trustDevice === true) {
    return json({ code: "TRUSTED_DEVICE_DISABLED", message: "Trusted-device 2FA verification is not enabled." }, 400);
  }

  let holder: SessionHolder | null = null;
  let proofAttempt: StaffAttempt | null = null;
  let routed = request;
  const provesInSession = verifiesSecondFactor || (method === "POST" && route === TWO_FACTOR_ENABLE_PATH);
  if (method === "POST" && route.startsWith(TWO_FACTOR_PATH_PREFIX)) {
    const lookup = await sessionHolder(authEnv, auth, request);
    // A dead session never reaches Better Auth (its cookie cache would still
    // honour it); the rest of the request goes on as a browser without one.
    if (lookup.kind === "dead") routed = withoutSessionCookies(request);
    holder = lookup.kind === "live" ? lookup.holder : null;
    if (route === TWO_FACTOR_ENABLE_PATH) {
      if (!holder) return json({ code: "SESSION_EXPIRED", message: "Sign in to set up two-step verification." }, 401);
      if (holder.user.twoFactorEnabled) {
        return json({ code: "TWO_FACTOR_ALREADY_ENABLED", message: "Two-step verification is already on. Change its method in Account settings." }, 409);
      }
    }
    if (provesInSession && holder) {
      const reserved = await reserveSessionProof(authEnv, holder);
      if ("refused" in reserved) return reserved.refused;
      proofAttempt = reserved.attempt;
    }
  }

  const isSignIn = method === "POST" && route === SIGN_IN_EMAIL_PATH;
  const signInGate = isSignIn ? await gateSignIn(authEnv, request) : null;
  if (signInGate && "refused" in signInGate) return signInGate.refused;
  let response = await withRetryAfter(await runWithRetry((attempt) => auth.handler(attempt), routed, isSignIn));
  // Better Auth answers 429 (its own limit, its two-step lockout) before checking anything.
  const checked = response.status !== 429;
  if (isSignIn) response = await offerAccountTwoFactorMethods(authEnv, request, response);
  if (signInGate) response = await settleSignIn(authEnv, signInGate, response, checked);
  if (verifiesSecondFactor) await markTwoFactorVerified(authEnv, response);
  if (proofAttempt && (response.ok || !checked)) await proofAttempt.refund();
  if (holder) await signOutOthersIfTwoStepTurnedOn(authEnv, holder, response);
  return withNoStore(response);
}
