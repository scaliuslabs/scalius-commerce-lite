// "Continue with <app>": the start and callback redirects, with a fixture
// identity app run by the bundled loader. The platform owns state, nonce and
// PKCE; the app only builds the sign-in URL and exchanges the code.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, writePluginSettings } from "@scalius/core/modules/plugins";
import { errorResponseFromError } from "../../utils/api-response";
import { PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv } from "../../plugins/testing/fixtures";
import {
  IDENTITY_FIXTURE_CODE,
  IDENTITY_FIXTURE_ID,
  IDENTITY_FIXTURE_MANIFEST,
  IDENTITY_FIXTURE_PROVIDER,
  IDENTITY_FIXTURE_SECRET,
} from "../../plugins/testing/identity-fixture";
import { IDENTITY_STATE_COOKIE, openIdentityState, sealIdentityState } from "./identity-state";

const sha256 = createHash("sha256").update(IDENTITY_FIXTURE_CODE).digest("hex");
const fixture = vi.hoisted(() => ({ module: null as unknown }));

// The request's provider runtime, with the fixture compiled in as a bundled plugin.
vi.mock("../../plugins/providers/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/providers/runtime")>();
  return {
    ...actual,
    requestProviderRuntime: (c: Parameters<typeof actual.requestProviderRuntime>[0]) => {
      const db = c.get("db");
      const ctx = pluginTestCtx();
      return {
        env: c.env,
        db,
        canRun: () => true,
        host: async () => {
          const [{ PluginHost }, { BundledLoader }] = await Promise.all([import("../../plugins/host"), import("../../plugins/loaders/bundled")]);
          const loader = new BundledLoader(
            { env: c.env, ctx, db: () => db, composedEnv: async () => c.env },
            { [IDENTITY_FIXTURE_ID]: { version: "1.0.0", sha256, load: async () => fixture.module } },
          );
          return new PluginHost({ env: c.env, ctx, db, loaderFor: () => loader });
        },
      };
    },
  };
});

import { customerIdentityRoutes } from "./identity";

const SECRET = "identity-route-test-master-secret-0123456789abcdef";
const STOREFRONT = "https://shop.test";
const CALLBACK = `${STOREFRONT}/api/customer-auth/identity/${IDENTITY_FIXTURE_PROVIDER}/callback`;
const ACCOUNT_ERROR = (error: string) => `${STOREFRONT}/account?sign_in_error=${error}`;

let workdir: string;
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "scalius-identity-routes-"));
  const file = join(workdir, "identity.mjs");
  writeFileSync(file, IDENTITY_FIXTURE_CODE);
  fixture.module = await import(pathToFileURL(file).href);
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe("Continue with an app", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  function createApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/", customerIdentityRoutes);
    return app;
  }

  const providerPath = (id = IDENTITY_FIXTURE_PROVIDER) => encodeURIComponent(id);

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding, { SCALIUS_SECRET: SECRET, CUSTOMER_SESSION_HASH_KEY: "identity-route-session-hash-key-0123456789" });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    const installed = await installPlugin(db, { manifest: IDENTITY_FIXTURE_MANIFEST, source: "upload", bundleSha256: sha256, actorUserId: "owner" });
    const configured = await writePluginSettings(db, IDENTITY_FIXTURE_ID, { client_secret: IDENTITY_FIXTURE_SECRET }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    await activatePlugin(db, IDENTITY_FIXTURE_ID, { actorUserId: "owner", expectedRevision: configured.revision });
  });
  afterEach(() => sqlite.close());

  const get = (path: string, cookie?: string, testEnv: Env = env) =>
    createApp().request(path, { headers: cookie ? { Cookie: cookie } : {} }, testEnv);

  /** Starts a sign-in and returns what the browser would keep and follow. */
  async function start(query = "") {
    const response = await get(`/identity/${providerPath()}/start${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    const setCookie = response.headers.get("set-cookie")!;
    const cookie = setCookie.split(";")[0]!;
    return { response, location, setCookie, cookie, state: location.searchParams.get("state")! };
  }

  const cookieValue = (header: string) => header.slice(header.indexOf("=") + 1);
  const setCookies = (response: Response) => response.headers.getSetCookie();
  const noSession = (response: Response) => expect(setCookies(response).some((cookie) => cookie.startsWith("cs_tok="))).toBe(false);

  it("start: redirects to the app's sign-in page with state, nonce and a PKCE challenge, and keeps the flow in one signed cookie", async () => {
    const { response, location, setCookie, cookie } = await start("?returnTo=%2Fproducts%2Ftee&locale=bn");
    expect(`${location.origin}${location.pathname}`).toBe("https://accounts.acme.test/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(location.searchParams.get("hl")).toBe("bn");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("cache-control")).toContain("no-store");

    expect(setCookie).toContain(`${IDENTITY_STATE_COOKIE}=`);
    expect(setCookie).toContain("Path=/api/v1/customer-auth/identity");
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toContain("Max-Age=600");

    const flow = await openIdentityState(env, cookieValue(cookie));
    expect(flow).toMatchObject({
      providerId: IDENTITY_FIXTURE_PROVIDER,
      state: location.searchParams.get("state"),
      nonce: location.searchParams.get("nonce"),
      returnTo: "/products/tee",
    });
    // The challenge the app received is the S256 of the verifier only the cookie holds.
    expect(createHash("sha256").update(flow!.codeVerifier).digest("base64url")).toBe(location.searchParams.get("code_challenge"));
    // Nothing secret is in the redirect URL.
    expect(location.toString()).not.toContain(flow!.codeVerifier);
  });

  it("start: only a same-site path can be returned to", async () => {
    for (const returnTo of ["https://evil.test/", "//evil.test", "/\\evil.test", "/a/../b", "javascript:alert(1)"]) {
      const { cookie } = await start(`?returnTo=${encodeURIComponent(returnTo)}`);
      expect((await openIdentityState(env, cookieValue(cookie)))?.returnTo).toBe("/account");
    }
    const { cookie } = await start();
    expect((await openIdentityState(env, cookieValue(cookie)))?.returnTo).toBe("/account");
  });

  it("start: an unknown or not-ready provider returns to the account page with a fixed error", async () => {
    const unknown = await get(`/identity/${providerPath("acme.other:google")}/start`);
    expect(unknown.status).toBe(302);
    expect(unknown.headers.get("location")).toBe(ACCOUNT_ERROR("identity"));
    expect(setCookies(unknown).join("\n")).toContain(`${IDENTITY_STATE_COOKIE}=; Max-Age=0`);

    const malformed = await get(`/identity/${providerPath("google")}/start`);
    expect(malformed.headers.get("location")).toBe(ACCOUNT_ERROR("identity"));

    sqlite.prepare("UPDATE plugin_installations SET status = 'disabled'").run();
    const inactive = await get(`/identity/${providerPath()}/start`);
    expect(inactive.headers.get("location")).toBe(ACCOUNT_ERROR("identity"));
  });

  it("start: refuses a store address that is not https (the callback must be)", async () => {
    const insecure = await get(`/identity/${providerPath()}/start`, undefined, { ...env, STOREFRONT_URL: "http://shop.test" } as Env);
    expect(insecure.status).toBe(302);
    expect(insecure.headers.get("location")).toBe("http://shop.test/account?sign_in_error=identity");
    expect(setCookies(insecure).join("\n")).not.toContain("Max-Age=600");
  });

  it("start: without a master secret nothing is signed or started", async () => {
    const response = await get(`/identity/${providerPath()}/start`, undefined, { ...env, SCALIUS_SECRET: undefined } as unknown as Env);
    expect(response.headers.get("location")).toBe(ACCOUNT_ERROR("identity"));
  });

  it("callback: a new buyer is created, signed in and sent back to where they were", async () => {
    const { cookie, state } = await start("?returnTo=%2Fproducts%2Ftee");
    const response = await get(`/identity/${providerPath()}/callback?code=new-user&state=${state}`, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${STOREFRONT}/products/tee`);

    const cookies = setCookies(response);
    expect(cookies.some((value) => /^cs_tok=.+; .*HttpOnly/.test(value))).toBe(true);
    expect(cookies.some((value) => value.startsWith("cs_auth=1;"))).toBe(true);
    expect(cookies.some((value) => value.startsWith(`${IDENTITY_STATE_COOKIE}=; Max-Age=0`))).toBe(true);
    expect(response.headers.get("location")).not.toContain("code=");

    expect(sqlite.prepare("SELECT name, email, phone FROM customers").all()).toEqual([{ name: "New Buyer", email: "new@example.test", phone: "+8801733333333" }]);
    expect(sqlite.prepare("SELECT provider_id, subject FROM customer_identities").all()).toEqual([{ provider_id: IDENTITY_FIXTURE_PROVIDER, subject: "sub-new" }]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM customer_sessions").get()).toEqual({ n: 1 });

    // Signing in again by the same person signs in the same customer.
    const again = await start();
    const second = await get(`/identity/${providerPath()}/callback?code=new-user&state=${again.state}`, again.cookie);
    expect(second.headers.get("location")).toBe(`${STOREFRONT}/account`);
    expect(sqlite.prepare("SELECT count(*) AS n FROM customers").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM customer_sessions").get()).toEqual({ n: 2 });
  });

  it("callback: a provider-verified email signs in the account that proved it; an unverified one asks for details and creates nothing", async () => {
    sqlite.prepare(`INSERT INTO customers (id, name, email, phone, origin, account_claimed_at, email_verified_at)
      VALUES ('cust_owner', 'Owner', 'owner@example.test', '+8801711111111', 'account', unixepoch(), unixepoch())`).run();

    const unverified = await start();
    const pretender = await get(`/identity/${providerPath()}/callback?code=unverified&state=${unverified.state}`, unverified.cookie);
    expect(pretender.headers.get("location")).toBe(ACCOUNT_ERROR("needs_details"));
    noSession(pretender);
    expect(sqlite.prepare("SELECT count(*) AS n FROM customer_identities").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM customers").get()).toEqual({ n: 1 });

    const verified = await start();
    const owner = await get(`/identity/${providerPath()}/callback?code=known-email&state=${verified.state}`, verified.cookie);
    expect(owner.headers.get("location")).toBe(`${STOREFRONT}/account`);
    expect(setCookies(owner).some((value) => value.startsWith("cs_tok="))).toBe(true);
    expect(sqlite.prepare("SELECT customer_id FROM customer_identities").all()).toEqual([{ customer_id: "cust_owner" }]);
  });

  describe("callback failures end on the account page with a fixed error", () => {
    async function expectFailed(response: Response, error = "identity") {
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(ACCOUNT_ERROR(error));
      noSession(response);
      expect(setCookies(response).some((value) => value.startsWith(`${IDENTITY_STATE_COOKIE}=; Max-Age=0`))).toBe(true);
      expect(sqlite.prepare("SELECT count(*) AS n FROM customers").get()).toEqual({ n: 0 });
      expect(sqlite.prepare("SELECT count(*) AS n FROM customer_sessions").get()).toEqual({ n: 0 });
    }

    it("a missing state cookie", async () => {
      const { state } = await start();
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=new-user&state=${state}`));
    });

    it("a tampered cookie", async () => {
      const { cookie, state } = await start();
      const [body, signature] = cookieValue(cookie).split(".");
      const forged = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(body!, "base64url").toString())), returnTo: "/steal" })).toString("base64url");
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=new-user&state=${state}`, `${IDENTITY_STATE_COOKIE}=${forged}.${signature}`));
      const flipped = signature!.slice(0, -1) + (signature!.endsWith("A") ? "B" : "A");
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=new-user&state=${state}`, `${IDENTITY_STATE_COOKIE}=${body}.${flipped}`));
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=new-user&state=${state}`, `${IDENTITY_STATE_COOKIE}=garbage`));
    });

    it("an expired cookie", async () => {
      const expired = await sealIdentityState(env, {
        providerId: IDENTITY_FIXTURE_PROVIDER,
        state: "s".repeat(43),
        nonce: "n".repeat(43),
        codeVerifier: "v".repeat(43),
        returnTo: "/account",
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      });
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=new-user&state=${"s".repeat(43)}`, `${IDENTITY_STATE_COOKIE}=${expired}`));
    });

    it("a state that does not match, or none", async () => {
      const { cookie } = await start();
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=new-user&state=${"x".repeat(43)}`, cookie));
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=new-user`, cookie));
    });

    it("a cookie made for another provider", async () => {
      const { cookie, state } = await start();
      await expectFailed(await get(`/identity/${providerPath("acme.signin:apple")}/callback?code=new-user&state=${state}`, cookie));
    });

    it("an error from the provider, or no code", async () => {
      const { cookie, state } = await start();
      await expectFailed(await get(`/identity/${providerPath()}/callback?error=access_denied&state=${state}`, cookie));
      await expectFailed(await get(`/identity/${providerPath()}/callback?state=${state}`, cookie));
    });

    it("a code the app refuses, and a code from another sign-in", async () => {
      const { cookie, state } = await start();
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=refused&state=${state}`, cookie));
      await expectFailed(await get(`/identity/${providerPath()}/callback?code=unknown&state=${state}`, cookie));
    });

    it("never puts provider output in the URL or the logs", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const { cookie, state } = await start();
        const response = await get(`/identity/${providerPath()}/callback?code=refused&state=${state}`, cookie);
        expect(response.headers.get("location")).not.toMatch(/refused|acme\.refused/);
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain("acme.refused");
        expect(logged).not.toContain(state);
        expect(logged).not.toContain("The code was refused");
      } finally {
        warn.mockRestore();
      }
    });
  });
});
