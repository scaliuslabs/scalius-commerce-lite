// The dashboard's WebSocket upgrade: authenticated once like an admin request,
// Origin-checked against cross-site hijacking, and forwarded to the hub with
// only the proven identity and the topics the permissions allow.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { presenceEditMask } from "@scalius/shared/realtime";

const session = vi.hoisted(() => ({
  value: null as null | { user: Record<string, unknown>; session: Record<string, unknown> },
  permissions: new Set<string>(),
}));

vi.mock("@scalius/database/client", () => ({ getDb: () => ({}) }));
vi.mock("../middleware/admin-auth", () => ({
  getAdminSessionFromCookieHeader: vi.fn(async () => session.value),
}));
vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  getUserPermissions: vi.fn(async () => session.permissions),
}));

const { handleRealtimeConnect } = await import("./connect");
const { REALTIME_IDENTITY_HEADER } = await import("./hub");

const DASHBOARD = "https://admin.shop.test";

function upgrade(init: { method?: string; origin?: string | null; upgrade?: boolean } = {}) {
  const headers = new Headers({ Cookie: "better-auth.session_token=signed", "Sec-WebSocket-Key": "abc==", "Sec-WebSocket-Version": "13" });
  if (init.upgrade !== false) headers.set("Upgrade", "websocket");
  if (init.origin !== null) headers.set("Origin", init.origin ?? DASHBOARD);
  return new Request(`${DASHBOARD}/api/realtime`, { method: init.method ?? "GET", headers });
}

describe("handleRealtimeConnect", () => {
  const hubFetch = vi.fn(async (_request: Request) => new Response("hub", { status: 200 }));
  const env = {
    BETTER_AUTH_SECRET: "secret",
    PLATFORM_CONFIG: { dashboardUrl: DASHBOARD },
    REALTIME_HUB: { idFromName: (name: string) => ({ toString: () => name }), get: () => ({ fetch: hubFetch }) },
  } as unknown as Env;

  beforeEach(() => {
    hubFetch.mockClear();
    session.value = { user: { id: "usr_1", name: "Rahim", isSuperAdmin: false }, session: { id: "ses_1", twoFactorVerified: true } };
    session.permissions = new Set(["orders.view", "conversations.view", "settings.checkout.edit"]);
  });

  it("forwards a proven staff member with their topics, never the cookie", async () => {
    const response = await handleRealtimeConnect(upgrade(), env);
    expect(response.status).toBe(200);
    const forwarded = hubFetch.mock.calls[0]![0];
    expect(forwarded.headers.get("Cookie")).toBeNull();
    expect(forwarded.headers.get("Sec-WebSocket-Key")).toBe("abc==");
    expect(JSON.parse(forwarded.headers.get(REALTIME_IDENTITY_HEADER)!)).toEqual({
      userId: "usr_1",
      name: "Rahim",
      topics: ["orders", "payments", "returns", "inbox", "settings"],
      edit: presenceEditMask(session.permissions),
    });
  });

  it.each([
    ["a non-GET", upgrade({ method: "POST" }), 405],
    ["a plain request", upgrade({ upgrade: false }), 426],
    ["no Origin", upgrade({ origin: null }), 403],
    ["another site's Origin", upgrade({ origin: "https://storefront.shop.test" }), 403],
  ])("refuses %s before any session read", async (_label, request, status) => {
    expect((await handleRealtimeConnect(request, env)).status).toBe(status);
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it("refuses without a session, with 2FA pending or without any permission", async () => {
    session.value = null;
    expect((await handleRealtimeConnect(upgrade(), env)).status).toBe(401);
    session.value = { user: { id: "usr_1", name: "Rahim", twoFactorEnabled: true }, session: { id: "ses_1", twoFactorVerified: false } };
    expect((await handleRealtimeConnect(upgrade(), env)).status).toBe(403);
    session.value = { user: { id: "usr_1", name: "Rahim" }, session: { id: "ses_1" } };
    session.permissions = new Set();
    expect((await handleRealtimeConnect(upgrade(), env)).status).toBe(403);
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it("answers 503 when the hub binding is missing", async () => {
    const response = await handleRealtimeConnect(upgrade(), { ...env, REALTIME_HUB: undefined } as Env);
    expect(response.status).toBe(503);
  });
});
