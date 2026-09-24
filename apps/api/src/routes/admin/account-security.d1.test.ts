import { createHmac } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "@scalius/core/auth";
import { autoSeedRbacIfNeeded } from "@scalius/core/auth/rbac/auto-seed";
import { adminInvitations, session as sessionTable, user as userTable, verification } from "@scalius/database/schema";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { EMPTY_PLATFORM_CONFIG } from "@scalius/shared/platform-config";

const outbox = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text?: string }>);
vi.mock("@scalius/core/integrations/email", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/integrations/email")>(),
  sendEmail: vi.fn(async (message: { to: string; subject: string; html: string; text?: string }) => {
    outbox.push(message);
    return { success: true, provider: "mailpit" as const };
  }),
}));

import { routeDashboardRequest } from "../../dashboard/surface";
import { adminAuthMiddleware } from "../../middleware/admin-auth";
import { errorResponseFromError } from "../../utils/api-response";
import { adminAuthManagementRoutes } from "./auth-management";

const DASHBOARD = "https://admin.shop.test";
const PASSWORD = "Correct-Horse-Battery-9";
const STORE = "Dhaka Crafts";

/** RFC 6238 (SHA-1, 6 digits, 30 s) for the base32 key an authenticator app is given. */
function totp(base32: string, nowMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/[\s=]+/g, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const value = (new DataView(hmac.buffer, hmac.byteOffset).getUint32(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}

function wrongCode(code: string): string {
  return ((Number(code) + 500_000) % 1_000_000).toString().padStart(6, "0");
}

let database: SqliteTestDatabase;

function makeEnv(): Env {
  return {
    DB: database.binding,
    BETTER_AUTH_SECRET: "account-security-test-secret-0123456789",
    PLATFORM_CONFIG: { ...EMPTY_PLATFORM_CONFIG, dashboardUrl: DASHBOARD },
    BETTER_AUTH_URL: DASHBOARD,
  } as unknown as Env;
}

async function authRoute(env: Env, path: string, init: RequestInit = {}) {
  const routed = await routeDashboardRequest(new Request(`${DASHBOARD}${path}`, init), env);
  if (!(routed instanceof Response)) throw new Error(`Expected a response for ${path}`);
  return routed;
}

function postAuth(env: Env, path: string, body: unknown, cookie?: string) {
  return authRoute(env, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: DASHBOARD, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function cookieNamed(response: Response, name: string): string {
  const header = response.headers.getSetCookie().find((cookie) => cookie.includes(`${name}=`) && !/Max-Age=0/i.test(cookie));
  if (!header) throw new Error(`No ${name} cookie was set`);
  return header.split(";")[0]!;
}

const sessionCookie = (response: Response) => cookieNamed(response, "session_token");

function adminApi(env: Env) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db" as never, database.db as never);
    await next();
  });
  app.use("/admin/*", adminAuthMiddleware);
  app.route("/admin/auth", adminAuthManagementRoutes);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return async (cookie: string, path: string, body?: unknown, method?: "DELETE") => {
    const response = await app.fetch(new Request(`${DASHBOARD}/api/v1/admin/auth${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, ctx);
    const rotated = response.headers.getSetCookie().find((value) => value.includes("session_token="));
    return {
      status: response.status,
      json: await response.json() as { data?: Record<string, unknown>; error?: { code?: string; message?: string } },
      cookie: rotated ? rotated.split(";")[0]! : cookie,
    };
  };
}

function signIn(env: Env, email: string, password = PASSWORD) {
  return postAuth(env, "/api/auth/sign-in/email", { email, password });
}

/** A store owner who finished onboarding with email codes, on a 2FA-verified session. */
async function ownerWithEmailCodes(env: Env) {
  const auth = createAuth(env);
  const { user } = await auth.api.signUpEmail({ body: { email: "owner@shop.test", password: PASSWORD, name: "Rahim" } });
  await database.db.update(userTable).set({ isSuperAdmin: true, role: "admin" }).where(eq(userTable.id, user.id));
  const firstCookie = sessionCookie(await signIn(env, "owner@shop.test"));
  const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: new Headers({ cookie: firstCookie }) });
  if (!("totpURI" in enabled)) throw new Error("Expected a TOTP enrolment");
  const secret = new URL(enabled.totpURI).searchParams.get("secret")!;
  const verified = await postAuth(env, "/api/auth/two-factor/verify-totp", { code: totp(secret) }, firstCookie);
  expect(verified.status).toBe(200);
  // Enabling rotates the session; onboarding (not under test here) marks the new one verified.
  await database.db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.userId, user.id));
  await database.db.update(userTable).set({ twoFactorMethod: "email" }).where(eq(userTable.id, user.id));
  return { userId: user.id, cookie: sessionCookie(verified) };
}

async function emailedCode(userId: string): Promise<string> {
  const row = await database.db.select({ value: verification.value }).from(verification)
    .where(like(verification.identifier, `2fa-otp-${userId}!%`)).get();
  if (!row) throw new Error("No email code was issued");
  return row.value.split(":")[0]!;
}

async function twoFactorMethod(userId: string) {
  return (await database.db.select({ method: userTable.twoFactorMethod }).from(userTable).where(eq(userTable.id, userId)).get())?.method;
}

function linkToken(html: string, key: "invite" | "token"): string {
  const match = html.match(new RegExp(`#${key}=([A-Za-z0-9_-]+)`));
  if (!match) throw new Error(`No #${key}= link in the email`);
  return match[1]!;
}

beforeEach(() => {
  outbox.length = 0;
  database = createSqliteD1Database({ foreignKeys: true });
  database.sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('business', 'document', ?, 'json', 'business')")
    .run(JSON.stringify({ companyName: STORE }));
});

afterEach(() => {
  database.sqlite.close();
});

describe("changing the two-step method", () => {
  it("switches from email codes to an authenticator app and back", async () => {
    const env = makeEnv();
    const { userId, cookie } = await ownerWithEmailCodes(env);
    const call = adminApi(env);

    const challenge = await call(cookie, "/2fa/method-challenge", { method: "totp", password: PASSWORD });
    expect(challenge.status).toBe(200);
    const key = new URL(String(challenge.json.data!.totpUri)).searchParams.get("secret")!;

    const switched = await call(cookie, "/2fa/method", { method: "totp", challengeId: challenge.json.data!.challengeId, code: totp(key) });
    expect(switched.status).toBe(200);
    const recoveryCodes = switched.json.data!.backupCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
    expect(await twoFactorMethod(userId)).toBe("totp");

    // The next sign-in accepts the new app's code through Better Auth itself.
    const pending = cookieNamed(await signIn(env, "owner@shop.test"), "two_factor");
    expect((await postAuth(env, "/api/auth/two-factor/verify-totp", { code: totp(key) }, pending)).status).toBe(200);

    const back = await call(cookie, "/2fa/method-challenge", { method: "email", password: PASSWORD });
    expect(back.status).toBe(200);
    expect((await postAuth(env, "/api/auth/two-factor/send-otp", {}, cookie)).status).toBe(200);
    expect(outbox.at(-1)?.subject).toBe(`Your ${STORE} verification code`);
    const emailed = await call(cookie, "/2fa/method", { method: "email", challengeId: back.json.data!.challengeId, code: await emailedCode(userId) });
    expect(emailed.status).toBe(200);
    expect(await twoFactorMethod(userId)).toBe("email");
  });

  it("answers a wrong authenticator code with a specific 4xx and keeps the old method", async () => {
    const env = makeEnv();
    const { userId, cookie } = await ownerWithEmailCodes(env);
    const call = adminApi(env);

    const challenge = await call(cookie, "/2fa/method-challenge", { method: "totp", password: PASSWORD });
    const key = new URL(String(challenge.json.data!.totpUri)).searchParams.get("secret")!;
    const rejected = await call(cookie, "/2fa/method", { method: "totp", challengeId: challenge.json.data!.challengeId, code: wrongCode(totp(key)) });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error?.code).toBe("TWO_FACTOR_CODE_INVALID");
    expect(await twoFactorMethod(userId)).toBe("email");

    // The same setup still completes with the right code.
    const retried = await call(cookie, "/2fa/method", { method: "totp", challengeId: challenge.json.data!.challengeId, code: totp(key) });
    expect(retried.status).toBe(200);
  });

  it("answers a wrong emailed code and a wrong password with their own 4xx codes", async () => {
    const env = makeEnv();
    const { userId, cookie } = await ownerWithEmailCodes(env);
    await database.db.update(userTable).set({ twoFactorMethod: "totp" }).where(eq(userTable.id, userId));
    const call = adminApi(env);

    const wrongPassword = await call(cookie, "/2fa/method-challenge", { method: "email", password: "Not-The-Password-1" });
    expect(wrongPassword.status).toBe(400);
    expect(wrongPassword.json.error?.code).toBe("PASSWORD_INCORRECT");

    const challenge = await call(cookie, "/2fa/method-challenge", { method: "email", password: PASSWORD });
    await postAuth(env, "/api/auth/two-factor/send-otp", {}, cookie);
    const rejected = await call(cookie, "/2fa/method", { method: "email", challengeId: challenge.json.data!.challengeId, code: wrongCode(await emailedCode(userId)) });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error?.code).toBe("TWO_FACTOR_CODE_INVALID");
  });
});

describe("changing the password", () => {
  it("refuses the current password as the new one without confirming a wrong guess", async () => {
    const env = makeEnv();
    const { cookie } = await ownerWithEmailCodes(env);
    const call = adminApi(env);

    const reused = await call(cookie, "/change-password", { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(reused.status).toBe(400);
    expect(reused.json.error?.code).toBe("PASSWORD_REUSED");

    const guess = await call(cookie, "/change-password", { currentPassword: "Wrong-Guess-12345", newPassword: "Wrong-Guess-12345" });
    expect(guess.status).toBe(400);
    expect(guess.json.error?.code).toBe("PASSWORD_INCORRECT");

    const wrong = await call(cookie, "/change-password", { currentPassword: "Wrong-Guess-12345", newPassword: "Brand-New-Secret-7" });
    expect(wrong.json.error?.code).toBe("PASSWORD_INCORRECT");
  });

  it("keeps the rotated session verified and emails a security notice", async () => {
    const env = makeEnv();
    const { cookie } = await ownerWithEmailCodes(env);
    const call = adminApi(env);

    const changed = await call(cookie, "/change-password", { currentPassword: PASSWORD, newPassword: "Brand-New-Secret-7" });
    expect(changed.status).toBe(200);
    expect(changed.cookie).not.toBe(cookie);
    // The next click is not sent back through two-step verification.
    expect((await call(changed.cookie, "/2fa/info")).status).toBe(200);

    const notice = outbox.at(-1)!;
    expect(notice).toMatchObject({ to: "owner@shop.test", subject: `Your ${STORE} password was changed` });
    expect(notice.text).toContain("If this wasn't you");
    expect(notice.html).toContain(`${DASHBOARD}/auth/forgot-password`);
    expect(notice.html).not.toMatch(/#token=|#invite=/);
  });
});

describe("staff sign-in and invites", () => {
  it("tells a suspended staff member why sign-in stopped", async () => {
    const env = makeEnv();
    const auth = createAuth(env);
    const { user } = await auth.api.signUpEmail({ body: { email: "staff@shop.test", password: PASSWORD, name: "Karim" } });
    await database.db.update(userTable).set({ role: "admin", banned: true }).where(eq(userTable.id, user.id));

    const response = await signIn(env, "staff@shop.test");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "BANNED_USER",
      message: "Your access to this store is suspended. Contact the store owner.",
    });
  });

  it("sends a 7-day store-branded invite, checks it on open and signs the person in", async () => {
    const env = makeEnv();
    const { cookie } = await ownerWithEmailCodes(env);
    const call = adminApi(env);

    await autoSeedRbacIfNeeded(database.db);
    const role = database.sqlite.prepare("SELECT id FROM roles WHERE name <> 'super_admin' LIMIT 1").get() as { id: string } | undefined;
    const invited = await call(cookie, "/users", { name: "Karim", email: "karim@shop.test", roleId: role?.id });
    expect(invited.status).toBe(201);
    const invite = outbox.at(-1)!;
    expect(invite).toMatchObject({ to: "karim@shop.test", subject: `Rahim invited you to ${STORE}` });
    expect(invite.html).toContain("Accept invite");
    expect(invite.text).toContain("expires in 7 days");
    expect(invite.html).not.toContain("Scalius");
    const firstToken = linkToken(invite.html, "invite");

    // Resending replaces the first link.
    const userId = String((invited.json.data!.user as { id: string }).id);
    expect((await call(cookie, `/users/${userId}/resend-setup`, {})).status).toBe(200);
    const token = linkToken(outbox.at(-1)!.html, "invite");
    expect((await postAuth(env, "/api/auth/reset-session", { token: firstToken })).status).toBe(400);

    const row = await database.db.select({ expiresAt: verification.expiresAt }).from(verification)
      .where(eq(verification.identifier, `reset-password:${token}`)).get();
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    const invitation = await database.db.select({ expiresAt: adminInvitations.expiresAt }).from(adminInvitations)
      .where(eq(adminInvitations.userId, userId)).get();
    expect(invitation!.expiresAt!.getTime()).toBe(row!.expiresAt.getTime());

    const opened = await postAuth(env, "/api/auth/reset-session", { token });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ purpose: "invite" });
    const resetSession = cookieNamed(opened, "__Host-scalius-password-reset");

    const accepted = await postAuth(env, "/api/auth/reset-password-session", { newPassword: "Karims-Own-Pass-1" }, resetSession);
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as { status: boolean; signedIn: boolean; twoFactorSetup?: { backupCodes: string[] } };
    expect(acceptedBody).toMatchObject({ status: true, signedIn: true });
    const karimCookie = sessionCookie(accepted);
    const state = await (await authRoute(env, "/api/auth/dashboard-session", { headers: { Cookie: karimCookie } })).json() as {
      session: { user: { email: string; mustChangePassword: boolean; mustEnrollTwoFactor: boolean } };
    };
    expect(state.session.user).toMatchObject({ email: "karim@shop.test", mustChangePassword: false, mustEnrollTwoFactor: true });
    // Accepting an invite is not a password change.
    expect(outbox.at(-1)!.subject).not.toContain("password was changed");

    // Two-step setup started with the password just set: the next page only
    // confirms the emailed code, never asks for the password again.
    expect(acceptedBody.twoFactorSetup?.backupCodes).toHaveLength(10);
    expect((await postAuth(env, "/api/auth/two-factor/send-otp", {}, karimCookie)).status).toBe(200);
    const enrolled = await call(karimCookie, "/2fa/method", { method: "email", code: await emailedCode(userId) });
    expect(enrolled.status).toBe(200);
    const after = await (await authRoute(env, "/api/auth/dashboard-session", { headers: { Cookie: enrolled.cookie } })).json() as {
      session: { user: { twoFactorEnabled: boolean; mustEnrollTwoFactor: boolean }; twoFactorVerified: boolean };
    };
    expect(after.session).toMatchObject({ user: { twoFactorEnabled: true, mustEnrollTwoFactor: false }, twoFactorVerified: true });

    // A used link is refused when the page opens, before any form, and says it was used.
    const reopened = await postAuth(env, "/api/auth/reset-session", { token });
    expect(reopened.status).toBe(400);
    expect(await reopened.json()).toMatchObject({ code: "TOKEN_USED" });
    // A replaced or unknown link reads as expired.
    expect(await (await postAuth(env, "/api/auth/reset-session", { token: firstToken })).json()).toMatchObject({ code: "INVALID_TOKEN" });
    expect(await (await postAuth(env, "/api/auth/reset-session", { token: "a".repeat(40) })).json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("says a cancelled invite was cancelled, not expired", async () => {
    const env = makeEnv();
    const { cookie } = await ownerWithEmailCodes(env);
    const call = adminApi(env);
    await autoSeedRbacIfNeeded(database.db);
    const role = database.sqlite.prepare("SELECT id FROM roles WHERE name <> 'super_admin' LIMIT 1").get() as { id: string } | undefined;
    const invited = await call(cookie, "/users", { name: "Nila", email: "nila@shop.test", roleId: role?.id });
    const token = linkToken(outbox.at(-1)!.html, "invite");
    const userId = String((invited.json.data!.user as { id: string }).id);

    expect((await call(cookie, `/users/${userId}`, undefined, "DELETE")).status).toBe(200);

    const reopened = await postAuth(env, "/api/auth/reset-session", { token });
    expect(reopened.status).toBe(400);
    expect(await reopened.json()).toMatchObject({ code: "TOKEN_CANCELLED" });
    // The token itself is not kept: only its hash marks the cancelled link.
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM verification WHERE identifier LIKE ?").get(`%${token}%`)).toMatchObject({ n: 0 });
  });

  it("keeps password-reset links short and sends a 2FA account to its challenge after the reset", async () => {
    const env = makeEnv();
    await ownerWithEmailCodes(env);

    expect((await postAuth(env, "/api/auth/request-password-reset", { email: "owner@shop.test", redirectTo: "/auth/reset-password" })).status).toBe(200);
    const reset = outbox.at(-1)!;
    expect(reset.subject).toBe(`Reset your ${STORE} password`);
    const token = linkToken(reset.html, "token");
    const row = await database.db.select({ expiresAt: verification.expiresAt }).from(verification)
      .where(eq(verification.identifier, `reset-password:${token}`)).get();
    expect(row!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);

    const opened = await postAuth(env, "/api/auth/reset-session", { token });
    expect(await opened.json()).toMatchObject({ purpose: "reset" });
    const done = await postAuth(env, "/api/auth/reset-password-session", { newPassword: "Owner-New-Secret-8" }, cookieNamed(opened, "__Host-scalius-password-reset"));
    expect(await done.json()).toMatchObject({ status: true, twoFactorRedirect: true });
    expect(cookieNamed(done, "two_factor")).toBeTruthy();
    expect(outbox.at(-1)!.subject).toBe(`Your ${STORE} password was changed`);
  });
});
