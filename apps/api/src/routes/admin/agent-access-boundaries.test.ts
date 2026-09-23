import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";
import type { AgentPrincipal } from "../../agent-access/types";
import { adminAgentAccessRoutes } from "./agent-access";

// Any database access is recorded and fails the request, so every rejection
// below is proven to happen before the route reads or writes agent authority.
let dbTouched = false;
const untouchableDb = new Proxy({}, {
  get() {
    dbTouched = true;
    throw new Error("database must not be touched");
  },
});

const principal: AgentPrincipal = {
  kind: "agent",
  grantId: "grant_self",
  credentialId: "agc_self",
  ownerUserId: "user_1",
  isSuperAdmin: true,
  resource: "dashboard",
  grantKind: "pat",
  preset: "custom",
  permissions: new Set(["orders.view"]),
  riskCeiling: "read",
  authorityRevision: 3,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
};

function createApp(options: {
  user?: Record<string, unknown>;
  twoFactorVerified?: boolean;
  agentPrincipal?: AgentPrincipal;
} = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", untouchableDb as never);
    c.set("user", { id: "user_1", isSuperAdmin: true, twoFactorEnabled: true, ...options.user } as never);
    c.set("session", { id: "session_1", twoFactorVerified: options.twoFactorVerified ?? true } as never);
    if (options.agentPrincipal) c.set("agentPrincipal", options.agentPrincipal as never);
    c.set("adminPermissions", new Set(["agent_access.manage", "orders.view", "orders.edit"]) as never);
    await next();
  });
  app.route("/agent-access", adminAgentAccessRoutes);
  return app;
}

function send(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) {
  return app.request(`/api/v1/admin/agent-access${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { AGENT_TOKEN_PEPPER: "p".repeat(32) } as unknown as Env);
}

const customGrant = { preset: "custom", resource: "dashboard", permissions: ["orders.view"], riskCeiling: "read" };

const ceremonies: Array<[string, string, unknown]> = [
  ["POST", "/tokens", { preset: "read", resource: "dashboard" }],
  ["POST", "/revoke-all", {}],
  ["POST", "/authorization-requests/req_1/approve", { preset: "read" }],
  ["POST", "/authorization-requests/req_1/deny", {}],
  ["POST", "/device-authorizations/lookup", { userCode: "ABCD-EFGH" }],
  ["POST", "/device-authorizations/dev_1/approve", { preset: "read" }],
  ["POST", "/device-authorizations/dev_1/deny", {}],
  ["PATCH", "/grants/grant_1", { label: "narrowed" }],
  ["DELETE", "/grants/grant_1", {}],
  ["POST", "/tokens/agc_1/rotate", {}],
];

describe("agent access management route boundaries", () => {
  beforeEach(() => {
    dbTouched = false;
  });

  it("lets a 2FA-verified Super Admin and an in-scope agent past the guards", async () => {
    expect((await send(createApp(), "POST", "/revoke-all", {})).status).toBe(500);
    expect(dbTouched).toBe(true);
    dbTouched = false;
    const app = createApp({ agentPrincipal: principal });
    await send(app, "POST", "/tokens", customGrant);
    expect(dbTouched).toBe(true);
  });

  it.each([
    ["not a Super Admin", { user: { isSuperAdmin: false } }],
    ["without 2FA enabled", { user: { twoFactorEnabled: false } }],
    ["with an unverified 2FA session", { twoFactorVerified: false }],
  ])("rejects every consent, device, and revoke ceremony %s", async (_, options) => {
    const app = createApp(options);
    for (const [method, path, body] of ceremonies) {
      const response = await send(app, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(dbTouched).toBe(false);
  });

  it("rejects agents whose live owner is no longer a Super Admin", async () => {
    const app = createApp({ agentPrincipal: { ...principal, isSuperAdmin: false } });
    expect((await send(app, "POST", "/revoke-all", {})).status).toBe(403);
  });

  it("prevents credential and grant pivots on agent self mutations", async () => {
    const app = createApp({ agentPrincipal: principal });
    expect((await send(app, "POST", "/tokens/agc_other/rotate", {})).status).toBe(404);
    expect((await send(app, "PATCH", "/grants/grant_other", { label: "x" })).status).toBe(404);
    expect((await send(app, "DELETE", "/grants/grant_other", {})).status).toBe(404);
    expect(dbTouched).toBe(false);
  });

  it("creates subordinate grants only within the live agent's resource and authority", async () => {
    const app = createApp({ agentPrincipal: principal });
    expect((await send(app, "POST", "/tokens", { preset: "read", resource: "storefront" })).status).toBe(403);
    expect((await send(app, "POST", "/tokens", { ...customGrant, permissions: ["orders.edit"] })).status).toBe(403);
    expect((await send(app, "POST", "/tokens", { ...customGrant, riskCeiling: "write" })).status).toBe(403);
    expect(dbTouched).toBe(false);
  });

  it("keeps secure browser handoffs human-only and 2FA-verified", async () => {
    const path = `/browser-handoffs/abh_${"a".repeat(20)}`;
    expect((await send(createApp({ agentPrincipal: principal }), "GET", path)).status).toBe(403);
    expect((await send(createApp({ agentPrincipal: principal }), "POST", path)).status).toBe(403);
    expect((await send(createApp({ twoFactorVerified: false }), "POST", path)).status).toBe(403);
    expect((await send(createApp(), "GET", path)).status).toBe(200);
  });
});
