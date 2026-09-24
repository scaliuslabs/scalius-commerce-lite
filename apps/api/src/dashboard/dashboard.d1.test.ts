import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "@scalius/core/auth";
import { createScannerTokenClaim } from "@scalius/core/auth/scanner-token-claims";
import { session as sessionTable, user as userTable } from "@scalius/database/schema";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { EMPTY_PLATFORM_CONFIG, type PlatformConfig } from "@scalius/shared/platform-config";

import { adminAuthMiddleware } from "../middleware/admin-auth";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { errorResponseFromError } from "../utils/api-response";
import type { DashboardSessionState } from "./auth";
import { applyBasePathToShell, routeDashboardRequest } from "./surface";

const DASHBOARD = "https://admin.shop.test";
const STOREFRONT = "https://shop.test";
const PASSWORD = "Correct-Horse-Battery-9";

/** RFC 6238 code for a base32 secret (SHA-1, 6 digits, 30 s). */
function totp(base32: string, nowMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) {
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

function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

const SHELL = `<!doctype html><html><head><meta name="scalius-dashboard-base-path" content=""><link rel="icon" href="/favicon.png" /><script type="module" crossorigin src="/assets/immutable/index-abc.js"></script></head><body><div id="root"></div></body></html>`;

function fakeAssets(): NonNullable<Env["ASSETS"]> {
  return {
    fetch: async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/index.html") return new Response(SHELL, { headers: { "Content-Type": "text/html" } });
      if (pathname === "/favicon.png") return new Response("png", { headers: { "Content-Type": "image/png" } });
      return new Response("Not Found", { status: 404 });
    },
  };
}

let database: SqliteTestDatabase;

function makeEnv(platform: Partial<PlatformConfig> = {}): Env {
  const config: PlatformConfig = {
    ...EMPTY_PLATFORM_CONFIG,
    dashboardUrl: DASHBOARD,
    storefrontUrl: STOREFRONT,
    apiUrl: "https://api.shop.test",
    ...platform,
  };
  return {
    DB: database.binding,
    CACHE: memoryKv(),
    ASSETS: fakeAssets(),
    BETTER_AUTH_SECRET: "dashboard-test-secret-0123456789abcdef",
    PLATFORM_CONFIG: config,
    BETTER_AUTH_URL: config.dashboardUrl || undefined,
    STOREFRONT_URL: config.storefrontUrl || undefined,
  } as unknown as Env;
}

async function route(env: Env, path: string, init: RequestInit = {}, origin = DASHBOARD) {
  const routed = await routeDashboardRequest(new Request(`${origin}${path}`, init), env);
  if (!(routed instanceof Response)) throw new Error(`Expected a response for ${path}`);
  return routed;
}

async function createSuperAdmin(env: Env, email = "owner@shop.test") {
  const auth = createAuth(env);
  const result = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Owner" } });
  await database.db.update(userTable)
    .set({ isSuperAdmin: true, role: "admin" })
    .where(eq(userTable.id, result.user.id));
  return result.user.id;
}

function signIn(env: Env, origin = DASHBOARD, email = "owner@shop.test") {
  return route(env, "/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
}

/** Every asserted session in these tests is signed in. */
type SessionState = DashboardSessionState & { session: NonNullable<DashboardSessionState["session"]> & { permissions: string[] } };

function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((cookie) => cookie.includes("session_token="));
  if (!header) throw new Error("No session cookie was set");
  return header.split(";")[0]!;
}

async function readState(env: Env, cookie?: string, headers: Record<string, string> = {}) {
  return route(env, "/api/auth/dashboard-session", {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
}

beforeEach(() => {
  database = createSqliteD1Database({ foreignKeys: true });
});

afterEach(() => {
  database.sqlite.close();
});

describe("dashboard sign-in on the API Worker", () => {
  it("reports a fresh store as needing first-admin setup", async () => {
    const response = await readState(makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ adminExists: false, session: null });
  });

  it("signs in with a first-party, HttpOnly, Secure, SameSite session cookie", async () => {
    const env = makeEnv();
    await createSuperAdmin(env);

    const response = await signIn(env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const cookie = response.headers.getSetCookie().find((value) => value.includes("session_token="))!;
    expect(cookie).toMatch(/^__Secure-better-auth\.session_token=/);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);

    const state = await (await readState(env, sessionCookie(response))).json() as SessionState;
    expect(state.adminExists).toBe(true);
    expect(state.session.user).toMatchObject({ email: "owner@shop.test", isSuperAdmin: true });
    expect(state.session.permissions.length).toBeGreaterThan(10);
  });

  it("tells a browser whose session someone else ended why it was signed out, and nobody else", async () => {
    const env = makeEnv();
    const userId = await createSuperAdmin(env);
    const cookie = sessionCookie(await signIn(env));

    // Suspending, removing or "sign out other devices" deletes the session row.
    await database.db.delete(sessionTable).where(eq(sessionTable.userId, userId));
    const revoked = await (await readState(env, cookie)).json() as DashboardSessionState;
    expect(revoked).toMatchObject({ session: null, signedOut: "access_changed" });

    // A session that simply ran out, a forged cookie, or no cookie: plain sign-in.
    const expiredCookie = sessionCookie(await signIn(env));
    await database.db.update(sessionTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessionTable.userId, userId));
    expect(await (await readState(env, expiredCookie)).json()).not.toHaveProperty("signedOut");
    const forged = `${cookie.split("=")[0]}=${encodeURIComponent("made-up-token.c2lnbmF0dXJl")}`;
    expect(await (await readState(env, forged)).json()).not.toHaveProperty("signedOut");
    expect(await (await readState(env)).json()).not.toHaveProperty("signedOut");
  });

  it("scopes the session cookie to the dashboard base path", async () => {
    const env = makeEnv({ dashboardUrl: `${STOREFRONT}/dashboard` });
    await createSuperAdmin(env);
    const response = await route(env, "/dashboard/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STOREFRONT },
      body: JSON.stringify({ email: "owner@shop.test", password: PASSWORD }),
    }, STOREFRONT);
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((value) => value.includes("session_token="))!;
    expect(cookie).toMatch(/;\s*Path=\/dashboard/i);
  });

  it("rejects sign-in and session reads from the storefront origin", async () => {
    const env = makeEnv();
    await createSuperAdmin(env);

    expect((await signIn(env, STOREFRONT)).status).toBe(403);
    const cookie = sessionCookie(await signIn(env));
    const foreignRead = await readState(env, cookie, { Origin: STOREFRONT });
    expect(foreignRead.status).toBe(403);
    expect(foreignRead.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("withholds permissions and blocks the admin API until 2FA is verified", async () => {
    const env = makeEnv();
    const userId = await createSuperAdmin(env);
    const cookie = sessionCookie(await signIn(env));
    await database.db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.id, userId));

    const state = await (await readState(env, cookie)).json() as SessionState;
    expect(state.session).toMatchObject({ twoFactorVerified: false, permissions: null });

    const admin = new Hono<{ Bindings: Env }>().basePath("/api/v1");
    admin.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    admin.use("*", async (c, next) => {
      c.set("db" as never, database.db as never);
      await next();
    });
    admin.use("/admin/*", dashboardOriginGuardMiddleware);
    admin.use("/admin/*", adminAuthMiddleware);
    admin.get("/admin/dashboard/summary", (c) => c.json({ success: true }));
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const call = (headers: Record<string, string>) =>
      admin.fetch(new Request(`${DASHBOARD}/api/v1/admin/dashboard/summary`, { headers }), env, ctx);

    expect((await call({ Cookie: cookie })).status).toBe(403);

    await database.db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.userId, userId));
    expect((await call({ Cookie: cookie })).status).toBe(200);
    // Same session, storefront page: refused even for a read.
    expect((await call({ Cookie: cookie, Origin: STOREFRONT })).status).toBe(403);
  });

  it("marks the session verified after a TOTP second factor and then grants access", async () => {
    const env = makeEnv();
    const userId = await createSuperAdmin(env);
    const firstCookie = sessionCookie(await signIn(env));
    const enabled = await createAuth(env).api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie: firstCookie }),
    });
    if (!("totpURI" in enabled)) throw new Error("Expected a TOTP enrolment");
    const { totpURI } = enabled;
    const secret = new URL(totpURI).searchParams.get("secret")!;
    const verify = (cookie: string) => route(env, "/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD, Cookie: cookie },
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect((await verify(firstCookie)).status).toBe(200);

    const passwordStep = await signIn(env);
    expect(await passwordStep.json()).toMatchObject({ twoFactorRedirect: true });
    const pending = passwordStep.headers.getSetCookie()
      .find((cookie) => cookie.includes("two_factor="))!
      .split(";")[0]!;
    expect((await readState(env, pending)).status).toBe(200);

    const verified = await verify(pending);
    expect(verified.status).toBe(200);
    const cookie = sessionCookie(verified);
    const state = await (await readState(env, cookie)).json() as SessionState;
    expect(state.session).toMatchObject({ twoFactorVerified: true, user: { id: userId, twoFactorEnabled: true } });
    expect(state.session.permissions.length).toBeGreaterThan(10);
  });

  it("keeps account creation and trusted devices off the public auth surface", async () => {
    const env = makeEnv();
    const signUp = await route(env, "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD },
      body: JSON.stringify({ email: "x@shop.test", password: PASSWORD, name: "X" }),
    });
    expect(signUp.status).toBe(403);

    const trusted = await route(env, "/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD },
      body: JSON.stringify({ code: "123456", trustDevice: true }),
    });
    expect(trusted.status).toBe(400);
  });
});

describe("dashboard host routing", () => {
  it("serves the shell only on the dashboard host", async () => {
    const env = makeEnv();
    const shell = await route(env, "/admin/orders");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("Cache-Control")).toContain("no-store");
    expect(await shell.text()).toContain('src="/assets/immutable/index-abc.js"');

    expect((await route(env, "/admin/orders", {}, "https://api.shop.test")).status).toBe(404);
    expect((await route(env, "/api/auth/dashboard-session", {}, "https://api.shop.test")).status).toBe(404);
  });

  it("serves any host until a Dashboard URL is configured", async () => {
    const env = makeEnv({ dashboardUrl: "" });
    expect((await route(env, "/auth/login", {}, "https://fresh.workers.test")).status).toBe(200);
  });

  it("applies a runtime base path to the shell, assets and API calls", async () => {
    const env = makeEnv({ dashboardUrl: `${STOREFRONT}/dashboard` });
    const shell = await (await route(env, "/dashboard/admin", {}, STOREFRONT)).text();
    expect(shell).toContain('<meta name="scalius-dashboard-base-path" content="/dashboard">');
    expect(shell).toContain('src="/dashboard/assets/immutable/index-abc.js"');
    expect(shell).toContain('href="/dashboard/favicon.png"');

    expect((await route(env, "/dashboard/favicon.png", {}, STOREFRONT)).status).toBe(200);

    const outside = await route(env, "/admin", {}, STOREFRONT);
    expect(outside.status).toBe(308);
    expect(outside.headers.get("Location")).toBe(`${STOREFRONT}/dashboard/admin`);

    const api = await routeDashboardRequest(new Request(`${STOREFRONT}/dashboard/api/v1/admin/orders?page=2`), env);
    expect(api).toBeInstanceOf(Request);
    expect((api as Request).url).toBe(`${STOREFRONT}/api/v1/admin/orders?page=2`);
  });

  it("leaves a shell without a base path untouched", () => {
    expect(applyBasePathToShell(SHELL, "")).toBe(SHELL);
  });
});

describe("scanner cookie exchange", () => {
  it("exchanges a body-carried pairing token for a scanner cookie once", async () => {
    const env = makeEnv();
    const adminId = await createSuperAdmin(env);
    const token = `sct_${"a".repeat(64)}`;
    await createScannerTokenClaim(database.db, { token, adminId, adminName: "Owner" });

    const inUrl = await route(env, `/api/scanner-token?token=${token}`);
    expect(inUrl.status).toBe(400);

    const foreign = await route(env, "/api/scanner-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STOREFRONT },
      body: JSON.stringify({ token }),
    });
    expect(foreign.status).toBe(403);

    const exchange = () => route(env, "/api/scanner-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD },
      body: JSON.stringify({ token }),
    });
    const first = await exchange();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, adminName: "Owner" });
    expect(first.headers.get("Set-Cookie")).toMatch(/HttpOnly; SameSite=Strict; .*Secure/);

    expect((await exchange()).status).toBe(401);
  });
});
