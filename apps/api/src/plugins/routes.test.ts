// Plugin routes through the real runtime family (base app, admin auth, RBAC)
// on the migrated schema, with plugins in the bundled loader: the reference
// plugin (acme.hello) and an echo plugin that returns the request it saw.
// Proves: only active plugins and declared routes/methods answer; admin
// routes need a dashboard session with apps.view (+ apps.use to change);
// public routes are rate-limited and body-capped; plugins never see cookies,
// credentials or network headers (webhooks keep provider headers and the raw
// body); responses are JSON with a deny-all CSP, never redirect, and cache
// only with an exact short public max-age; the storefront proxy flag is
// honoured.
import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The reference app is a sample, not in scalius.plugins.json: add it to the bundled registry.
vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withHelloBundled(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, deactivatePlugin, installPlugin, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins";
import { createRuntimeApiApp } from "../runtime/base-app";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { BundledLoader } from "./loaders/bundled";
import { createPluginRoutes, filterPluginRequestHeaders, parsePluginRoutePath, pluginResponseCacheControl } from "./routes";
import { installHello, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const ECHO_SHA = "d".repeat(64);
const echoManifest = {
  id: "acme.echo",
  name: "Echo",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Returns the request it saw.",
  author: { name: "Acme" },
  scopes: ["write_marketing"],
  routes: {
    admin: [{ name: "look", methods: ["GET", "POST"] }, { name: "send", methods: ["POST"], scope: "write_marketing" }],
    public: [{ name: "inspect", methods: ["GET", "POST"] }, { name: "boom", methods: ["GET"] }],
    webhooks: [{ name: "hook" }],
  },
};
const echoModule = {
  default: {
    manifest: echoManifest,
    routes: {
      admin: { look: async (request: unknown) => ({ body: request }), send: async (request: unknown) => ({ body: request }) },
      public: {
        inspect: async (request: unknown) => ({
          headers: { "cache-control": "public, max-age=999", location: "https://evil.example/", "x-echo": "1" },
          body: request,
        }),
        boom: async () => {
          throw new Error("Customer rahim@example.com exploded");
        },
      },
      webhooks: { hook: async (request: unknown) => ({ body: request }) },
    },
  },
};

const PROXY_SHA = "e".repeat(64);
const proxyManifest = {
  id: "acme.who",
  name: "Who",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Tells who is signed in.",
  author: { name: "Acme" },
  routes: { public: [{ name: "who", methods: ["GET", "POST"] }] },
  storefront: { proxy: true },
};
const proxyModule = {
  default: {
    manifest: proxyManifest,
    routes: {
      public: {
        who: async (request: { customer?: unknown; headers: Record<string, string> }) => ({
          body: { customer: request.customer ?? null, cookie: request.headers.cookie ?? null },
        }),
      },
    },
  },
};

const STAFF: Record<string, string[] | null> = {
  owner: null, // Super Admin
  viewer: ["apps.view"],
  operator: ["apps.view", "apps.use"],
  sender: ["apps.view", "apps.use", "marketing.send"],
  clerk: ["orders.view"],
};

describe("plugin routes", { timeout: 30_000 }, () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let limited = false;
  let app: ReturnType<typeof createRuntimeApiApp>;

  function cookieFor(userId: string): string {
    const token = `tok_${userId}`;
    const signature = createHmac("sha256", String(env.BETTER_AUTH_SECRET)).update(token).digest("base64");
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  }

  async function call(path: string, init: RequestInit & { as?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.as) headers.set("Cookie", cookieFor(init.as));
    const response = await app.fetch(new Request(`https://api.shop.test${path}`, { ...init, headers }), env, pluginTestCtx());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the route, asserted field by field
    const json: any = parseBody(await response.text());
    return { status: response.status, headers: response.headers, json };
  }

  function parseBody(text: string): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  beforeEach(async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    limited = false;
    env = pluginTestEnv(binding, {
      RL_STANDARD: { limit: vi.fn(async () => ({ success: !limited })) },
    });
    await installHello(db, sqlite);
    for (const [id, permissions] of Object.entries(STAFF)) {
      if (id !== "owner") {
        sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES (?, ?, ?, 1, 'staff', 0)").run(id, id, `${id}@shop.test`);
      }
      expect(permissions === null || Array.isArray(permissions)).toBe(true);
      // Each staff member's grants, as the database resolves them.
      for (const name of permissions ?? []) {
        const [resource, action] = name.split(".");
        sqlite.prepare("INSERT OR IGNORE INTO permissions (id, name, display_name, resource, action, category) VALUES (?, ?, ?, ?, ?, ?)")
          .run(`perm_${name}`, name, name, resource!, action!, resource!);
        sqlite.prepare("INSERT INTO user_permissions (id, user_id, permission_id, granted) SELECT ?, ?, id, 1 FROM permissions WHERE name = ?")
          .run(`up_${id}_${name}`, id, name);
      }
      sqlite.prepare("INSERT INTO session (id, user_id, token, expires_at, two_factor_verified) VALUES (?, ?, ?, unixepoch() + 3600, 1)").run(`ses_${id}`, id, `tok_${id}`);
    }
    await installPlugin(db, { manifest: echoManifest, source: "bundled", bundleSha256: ECHO_SHA });
    await activatePlugin(db, "acme.echo", { actorUserId: "owner", expectedRevision: 1 });
    const bridgeEnvironment = { env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env };
    const loader = new BundledLoader(bridgeEnvironment, {
      ...BUNDLED_PLUGINS,
      "acme.echo": { version: "1.0.0", sha256: ECHO_SHA, load: async () => echoModule },
      "acme.who": { version: "1.0.0", sha256: PROXY_SHA, load: async () => proxyModule },
    });
    app = createRuntimeApiApp();
    app.route("/", createPluginRoutes({ loaderFor: () => loader }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  it("serves a public route of an active plugin as JSON, private by default and never storing cookies", async () => {
    const greet = await call("/api/v1/plugins/acme.hello/public/greet?name=Karim");
    expect(greet.status).toBe(200);
    expect(greet.json).toEqual({ message: "Salam, Karim!", visits: 1 });
    expect(greet.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(greet.headers.get("cache-control")).toBe("no-store");
    expect(greet.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(greet.headers.get("set-cookie")).toBeNull();
    // An exact, short public max-age is the only opt-in to caching.
    const visits = await call("/api/v1/plugins/acme.hello/public/visits");
    expect(visits.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("parses JSON and form bodies, refuses bad JSON and oversized bodies", async () => {
    const json = await call("/api/v1/plugins/acme.hello/public/visits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rina" }) });
    expect(json).toMatchObject({ status: 201, json: { message: "Welcome, Rina!" } });
    const form = await call("/api/v1/plugins/acme.hello/public/visits", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=Tania" });
    expect(form).toMatchObject({ status: 201, json: { message: "Welcome, Tania!" } });
    const bad = await call("/api/v1/plugins/acme.hello/public/visits", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(bad).toMatchObject({ status: 400, json: { error: { code: "INVALID_JSON" } } });
    const huge = await call("/api/v1/plugins/acme.hello/public/visits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(300 * 1024) }) });
    expect(huge.status).toBe(413);
  });

  it("answers only declared routes and methods of active plugins", async () => {
    expect((await call("/api/v1/plugins/acme.hello/public/nope")).status).toBe(404);
    const wrongMethod = await call("/api/v1/plugins/acme.hello/public/greet", { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect((await call("/api/v1/plugins/acme.unknown/public/greet")).status).toBe(404);
    expect((await call("/api/v1/plugins/acme.hello/public/greet/..%2F..%2Fadmin")).status).toBe(404);
    const echo = await requirePluginInstallation(db, "acme.echo");
    await deactivatePlugin(db, "acme.echo", { expectedRevision: echo.revision });
    expect((await call("/api/v1/plugins/acme.echo/public/inspect")).status).toBe(404);
  });

  it("filters what a public route sees and what it may answer", async () => {
    const seen = await call("/api/v1/plugins/acme.echo/public/inspect/a/b?x=1&y=2", {
      headers: {
        "Accept-Language": "bn",
        Authorization: "Bearer secret",
        Cookie: "cs_tok=abc",
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "10.0.0.1",
        "X-Custom": "nope",
      },
    });
    expect(seen.status).toBe(200);
    expect(seen.json).toEqual({
      method: "GET",
      subpath: "a/b",
      query: { x: "1", y: "2" },
      headers: { "accept-language": "bn" },
      body: null,
      rawBody: null,
      staffId: null,
      customer: null,
    });
    // Its own cache wish beyond 300 s is refused; it can never redirect.
    expect(seen.headers.get("cache-control")).toBe("no-store");
    expect(seen.headers.get("location")).toBeNull();
    expect(seen.headers.get("x-echo")).toBe("1");

    const failed = await call("/api/v1/plugins/acme.echo/public/boom");
    expect(failed).toMatchObject({ status: 502, json: { error: { code: "APP_FAILED", message: "The app could not answer." } } });
  });

  it("gives webhook routes the raw body and provider headers, never credentials", async () => {
    const body = JSON.stringify({ type: "charge.succeeded", amount: 100 });
    const hook = await call("/api/v1/plugins/acme.echo/webhooks/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=abc", Cookie: "x=1", Authorization: "Basic abc" },
      body,
    });
    expect(hook.status).toBe(200);
    expect(hook.json.rawBody).toBe(body);
    expect(hook.json.body).toEqual({ type: "charge.succeeded", amount: 100 });
    expect(hook.json.headers["stripe-signature"]).toBe("t=1,v1=abc");
    expect(hook.json.headers.cookie).toBeUndefined();
    expect(hook.json.headers.authorization).toBeUndefined();
    expect((await call("/api/v1/plugins/acme.echo/webhooks/hook", { method: "PUT" })).status).toBe(405);
    // A webhook answers POST unless its route declares more.
    expect((await call("/api/v1/plugins/acme.echo/webhooks/hook", { method: "GET" })).status).toBe(405);
  });

  it("rate-limits public and webhook routes per client", async () => {
    limited = true;
    const refused = await call("/api/v1/plugins/acme.hello/public/greet");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await call("/api/v1/plugins/acme.echo/webhooks/hook", { method: "POST" })).status).toBe(429);
  });

  it("serves the storefront proxy only for plugins that declare it", async () => {
    expect((await call("/api/v1/plugins/acme.hello/public/greet", { headers: { "x-scalius-app-proxy": "1" } })).status).toBe(200);
    expect((await call("/api/v1/plugins/acme.echo/public/inspect", { headers: { "x-scalius-app-proxy": "1" } })).status).toBe(404);
  });

  it("tells a proxied public route who is signed in, from the store's session, never the cookie itself", async () => {
    env = { ...env, CUSTOMER_SESSION_HASH_KEY: "plugin-proxy-session-hash-key-0123456789" } as unknown as Env;
    sqlite.exec("INSERT INTO customers (id, name, email, phone) VALUES ('cust_buyer', 'Buyer', 'buyer@example.test', '+8801711000009')");
    sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, unixepoch() + 3600)")
      .run(await hashCustomerSessionToken("cs-session-token-buyer", "plugin-proxy-session-hash-key-0123456789"), "cust_buyer");
    await installPlugin(db, { manifest: proxyManifest, source: "bundled", bundleSha256: PROXY_SHA });
    await activatePlugin(db, "acme.who", { actorUserId: "owner", expectedRevision: 1 });

    const signedIn = await call("/api/v1/plugins/acme.who/public/who", { headers: { "x-scalius-app-proxy": "1", Cookie: "cs_tok=cs-session-token-buyer; other=1" } });
    expect(signedIn.json).toEqual({ customer: { id: "cust_buyer" }, cookie: null });
    // Guests, unknown sessions and requests that did not come through the storefront proxy carry no customer.
    expect((await call("/api/v1/plugins/acme.who/public/who", { headers: { "x-scalius-app-proxy": "1" } })).json.customer).toBeNull();
    expect((await call("/api/v1/plugins/acme.who/public/who", { headers: { "x-scalius-app-proxy": "1", Cookie: "cs_tok=forged" } })).json.customer).toBeNull();
    expect((await call("/api/v1/plugins/acme.who/public/who", { headers: { Cookie: "cs_tok=cs-session-token-buyer" } })).json.customer).toBeNull();
    // A plugin without the proxy never learns anyone, even with the header.
    const echo = await call("/api/v1/plugins/acme.echo/public/inspect", { headers: { Cookie: "cs_tok=cs-session-token-buyer" } });
    expect(echo.json.customer).toBeNull();
  });

  it("guards admin routes with the dashboard session: apps.view to read, apps.use to change", async () => {
    expect((await call("/api/v1/plugins/acme.hello/admin/dashboard")).status).toBe(401);
    expect((await call("/api/v1/plugins/acme.hello/admin/dashboard", { as: "clerk" })).status).toBe(403);
    const page = await call("/api/v1/plugins/acme.hello/admin/dashboard", { as: "viewer" });
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ version: 1, root: { type: "page", title: "Hello" } });
    expect(page.headers.get("cache-control")).toBe("private, no-store");

    expect((await call("/api/v1/plugins/acme.hello/admin/reset", { method: "POST", as: "viewer" })).status).toBe(403);
    const reset = await call("/api/v1/plugins/acme.hello/admin/reset", { method: "POST", as: "operator", headers: { Origin: "https://admin.shop.test" } });
    expect(reset).toMatchObject({ status: 200, json: { toast: { message: "Counters reset.", tone: "success" }, refresh: true } });
    expect((await call("/api/v1/plugins/acme.hello/admin/reset", { method: "POST", as: "owner", headers: { Origin: "https://evil.example" } })).status).toBe(403);

    const seen = await call("/api/v1/plugins/acme.echo/admin/look?tab=1", { as: "owner", headers: { "X-Custom": "no" } });
    expect(seen.json).toMatchObject({ staffId: "owner", query: { tab: "1" }, headers: {} });
    // RBAC passes for a Super Admin; the route still answers only its declared methods.
    expect((await call("/api/v1/plugins/acme.echo/admin/look", { as: "owner", method: "PATCH" })).status).toBe(405);
  });

  it("does not let an app grant elevate an operator into sending", async () => {
    const send = (as: string) => call("/api/v1/plugins/acme.echo/admin/send", { method: "POST", as, headers: { Origin: "https://admin.shop.test" } });
    expect((await send("operator")).status).toBe(403);
    expect((await send("viewer")).status).toBe(403);
    expect(await send("sender")).toMatchObject({ status: 200, json: { staffId: "sender" } });
    expect((await send("owner")).status).toBe(200);
    const echo = await requirePluginInstallation(db, "acme.echo");
    await deactivatePlugin(db, "acme.echo", { expectedRevision: echo.revision });
    expect((await send("sender")).status).toBe(404);
  });
});

describe("plugin route helpers", () => {
  it("parses only well-formed plugin paths", () => {
    expect(parsePluginRoutePath("/api/v1/plugins/acme.x/admin/page")).toEqual({ surface: "admin", pluginId: "acme.x", name: "page", subpath: "" });
    expect(parsePluginRoutePath("/api/v1/plugins/acme.x/public/page/a/b")).toMatchObject({ subpath: "a/b" });
    for (const bad of ["/api/v1/plugins/ACME.x/public/a", "/api/v1/plugins/acme.x/secret/a", "/api/v1/plugins/acme.x/public/A", "/api/v1/plugins/acme.x/public/a/../b", "/api/v1/plugins/acme.x/public/a/%2e%2e", "/api/v1/plugins/acme.x/public/a/x%2Fy"]) {
      expect(parsePluginRoutePath(bad), bad).toBeNull();
    }
  });

  it("filters headers per surface and decides caching conservatively", () => {
    const headers = new Headers({ Accept: "application/json", "X-Hub-Signature-256": "sha256=1", Cookie: "a=1", "CF-Ray": "1", "X-Scalius-App-Proxy": "1" });
    expect(filterPluginRequestHeaders(headers, "public")).toEqual({ accept: "application/json" });
    expect(filterPluginRequestHeaders(headers, "webhooks")).toEqual({ accept: "application/json", "x-hub-signature-256": "sha256=1" });
    expect(pluginResponseCacheControl("admin", "public, max-age=60")).toBe("private, no-store");
    expect(pluginResponseCacheControl("public", "public, max-age=300")).toBe("public, max-age=300");
    expect(pluginResponseCacheControl("public", "public, max-age=301")).toBe("no-store");
    expect(pluginResponseCacheControl("public", "public, max-age=60, s-maxage=86400")).toBe("no-store");
    expect(pluginResponseCacheControl("webhooks", undefined)).toBe("no-store");
  });
});
