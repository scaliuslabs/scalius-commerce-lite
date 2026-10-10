// Staff Web Push routes: the device list carries each browser's delivery
// status, and a test notification goes only to the caller's own browser,
// rate-limited, and says what the push service answered.
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({ sendStaffTestPush: vi.fn() }));
vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
  sendStaffTestPush: mocks.sendStaffTestPush,
}));

import { adminWebPushRoutes } from "./web-push";

const SECRET = "a-master-secret-for-web-push-tests-0123456789abcdef";

function createTestApp(options: { https?: boolean; allow?: boolean } = {}) {
  const { db, sqlite } = createSqliteD1Database();
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role) VALUES ('usr_1', 'Staff', 'staff@shop.test', 1, 'admin');
    INSERT INTO push_subscriptions (id, audience, user_id, endpoint, p256dh, auth, device_label, failure_count)
      VALUES ('psb_0123456789abcdef01234567', 'staff', 'usr_1', 'https://fcm.googleapis.com/fcm/send/a', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'aaaaaaaaaaaaaaaaaaaaaa', 'Chrome on Android', 2);
  `);
  const limit = vi.fn(async () => ({ success: options.allow ?? true }));
  const env = {
    SCALIUS_SECRET: SECRET,
    BETTER_AUTH_URL: options.https === false ? "http://localhost:4323" : "https://admin.shop.test",
    PUBLIC_API_BASE_URL: "https://api.shop.test",
    RL_STRICT: { limit },
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/web-push");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    (c as unknown as { set(key: string, value: unknown): void }).set("user", { id: "usr_1" });
    await next();
  });
  app.route("/", adminWebPushRoutes);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request(`/api/v1/admin/web-push${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, env);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { request, limit };
}

const note = { title: "Test notification", body: "Notifications work on this device." };

describe("staff web push routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the caller's devices with their delivery status", async () => {
    const { request } = createTestApp();
    const { status, body } = await request("");
    expect(status).toBe(200);
    expect(body.data.available).toBe(true);
    expect(body.data.devices).toEqual([expect.objectContaining({ id: "psb_0123456789abcdef01234567", deviceLabel: "Chrome on Android", failureCount: 2, lastSuccessAt: null })]);
  });

  it("sends a test to the caller's own device and says what the push service answered", async () => {
    const { request, limit } = createTestApp();
    mocks.sendStaffTestPush.mockResolvedValueOnce("sent").mockResolvedValueOnce("retry").mockResolvedValueOnce(null);
    expect(await request("/devices/psb_0123456789abcdef01234567/test", "POST", note)).toEqual({ status: 200, body: expect.objectContaining({ data: { outcome: "sent" } }) });
    expect(mocks.sendStaffTestPush).toHaveBeenCalledWith(expect.anything(), expect.anything(), "usr_1", "psb_0123456789abcdef01234567", note);
    expect(limit).toHaveBeenCalledTimes(1);
    expect((await request("/devices/psb_0123456789abcdef01234567/test", "POST", note)).body.data).toEqual({ outcome: "failed" });
    expect((await request("/devices/psb_other/test", "POST", note)).status).toBe(404);
  });

  it("refuses when rate-limited, without an https address, or with an empty title", async () => {
    expect((await createTestApp({ allow: false }).request("/devices/psb_0123456789abcdef01234567/test", "POST", note)).status).toBe(429);
    expect((await createTestApp({ https: false }).request("/devices/psb_0123456789abcdef01234567/test", "POST", note)).status).toBe(503);
    expect((await createTestApp().request("/devices/psb_0123456789abcdef01234567/test", "POST", { title: " ", body: "" })).status).toBe(400);
    expect(mocks.sendStaffTestPush).not.toHaveBeenCalled();
  });
});
