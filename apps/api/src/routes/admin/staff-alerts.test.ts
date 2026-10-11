import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { ConflictError, NotFoundError } from "../../utils/api-error";
import { errorResponseFromError } from "../../utils/api-response";
import { DASHBOARD_SETTINGS_OPERATIONS } from "../../openapi/operation-registry/dashboard-settings";

const core = vi.hoisted(() => ({
  readStaffAlerts: vi.fn(), readStaffAlertSummary: vi.fn(), markStaffAlertRead: vi.fn(),
  markAllStaffAlertsRead: vi.fn(), clearStaffAlerts: vi.fn(), undoStaffAlertsClear: vi.fn(),
}));
vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
  ...core,
}));
import { adminStaffAlertRoutes } from "./staff-alerts";

const SUMMARY = {
  head: 111, unreadCount: 99, unreadCountCapped: true, countCap: 99,
  scopes: [{ scope: "orders", revision: 3, readThrough: 4, clearedThrough: 2 }],
};
const PAGE = {
  ...SUMMARY,
  items: [{ seq: 111, id: "evt_1", scope: "orders", kind: "order_created", subjectId: "ord_1", occurredAt: "2026-10-12T00:00:00.000Z", orderNumber: "0012", read: false, href: "/admin/orders/ord_1" }],
  nextBefore: 111,
};
const CLEAR = { operationId: "click-001", through: 111, scopes: [{ scope: "orders", revision: 3 }, { scope: "conversations", revision: 7 }] };
const UNDO = { operationId: "click-001", scopes: [{ scope: "orders", revision: 4 }, { scope: "conversations", revision: 8 }] };
const endpoints = [
  ["GET", "", "feed"], ["GET", "/summary", "summary"], ["POST", "/111/read", "read"],
  ["POST", "/read-all", "read_all"], ["POST", "/clear-all", "clear_all"], ["POST", "/clear-all/undo", "undo_clear_all"],
] as const;

function testApp(userId: string | null = "staff_own") {
  const db = {};
  const app = new OpenAPIHono<{ Bindings: Env }>();
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    if (userId) c.set("user", { id: userId } as never);
    await next();
  });
  app.route("/api/v1/admin/notifications", adminStaffAlertRoutes);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request(`/api/v1/admin/notifications${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, cache: response.headers.get("Cache-Control"), body: await response.json() };
  };
  return { app, request, db };
}

beforeEach(() => {
  vi.resetAllMocks();
  core.readStaffAlerts.mockResolvedValue(PAGE);
  core.readStaffAlertSummary.mockResolvedValue(SUMMARY);
  core.markStaffAlertRead.mockResolvedValue({ summary: SUMMARY });
  core.markAllStaffAlertsRead.mockResolvedValue({ summary: SUMMARY });
  core.clearStaffAlerts.mockResolvedValue({ summary: SUMMARY, undo: UNDO });
  core.undoStaffAlertsClear.mockResolvedValue({ summary: SUMMARY });
});

describe("private staff alert HTTP boundary", () => {
  it("requires caller identity on every endpoint, before any core read or mutation", async () => {
    const { request } = testApp(null);
    for (const [method, path] of endpoints) {
      const response = await request(path, method, method === "POST" ? CLEAR : undefined);
      expect(response.status).toBe(401);
      expect(response.cache).toBe("private, no-store");
    }
    for (const fn of Object.values(core)) expect(fn).not.toHaveBeenCalled();
  });

  it("returns the direct capped-count page and summary contracts, keyed only by authenticated user", async () => {
    const { request, db } = testApp();
    expect(await request("?beforeSeq=112&limit=50")).toEqual({ status: 200, cache: "private, no-store", body: { success: true, data: PAGE } });
    expect(core.readStaffAlerts).toHaveBeenCalledWith(db, "staff_own", { beforeSeq: 112, limit: 50 });
    await request("");
    expect(core.readStaffAlerts).toHaveBeenLastCalledWith(db, "staff_own", { limit: 20 });
    expect(await request("/summary?userId=staff_other")).toEqual({ status: 200, cache: "private, no-store", body: { success: true, data: SUMMARY } });
    expect(core.readStaffAlertSummary).toHaveBeenCalledWith(db, "staff_own");
  });

  it("returns truthful zero/empty state without adding scopes or changing cap meaning", async () => {
    const empty = { head: 0, unreadCount: 0, unreadCountCapped: false, countCap: 99, scopes: [], items: [], nextBefore: null };
    core.readStaffAlerts.mockResolvedValueOnce(empty);
    expect((await testApp().request("")).body).toEqual({ success: true, data: empty });
  });

  it("rejects unbounded cursors/pages and caller identity in scoped feed input", async () => {
    const { request } = testApp();
    for (const query of ["limit=0", "limit=51", "limit=1.5", "beforeSeq=0", "beforeSeq=Infinity", "beforeSeq=9007199254740992", "userId=staff_other"]) {
      expect((await request(`?${query}`)).status).toBe(400);
    }
    expect(core.readStaffAlerts).not.toHaveBeenCalled();
  });

  it("passes single-read identity from context and preserves inaccessible-item 404", async () => {
    const { request, db } = testApp();
    expect((await request("/111/read", "POST", { userId: "staff_other" })).status).toBe(200);
    expect(core.markStaffAlertRead).toHaveBeenCalledWith(db, "staff_own", 111);
    core.markStaffAlertRead.mockRejectedValueOnce(new NotFoundError("Notification not found"));
    expect((await request("/112/read", "POST")).status).toBe(404);
    for (const seq of ["0", "-1", "1.1", "9007199254740992"]) expect((await request(`/${seq}/read`, "POST")).status).toBe(400);
    expect(core.markStaffAlertRead).toHaveBeenCalledTimes(2);
  });

  it("passes the observed head and explicit rendered scopes to one read-all operation", async () => {
    const { request, db } = testApp();
    const input = { through: 111, scopes: ["orders", "conversations"] };
    expect((await request("/read-all", "POST", input)).status).toBe(200);
    expect(core.markAllStaffAlertsRead).toHaveBeenCalledWith(db, "staff_own", input);
  });

  it("passes Clear/Undo unchanged to one atomic core operation and returns the exact undo token", async () => {
    const { request, db } = testApp();
    expect((await request("/clear-all", "POST", CLEAR)).body).toEqual({ success: true, data: { summary: SUMMARY, undo: UNDO } });
    expect(core.clearStaffAlerts).toHaveBeenCalledWith(db, "staff_own", CLEAR);
    expect((await request("/clear-all/undo", "POST", UNDO)).body).toEqual({ success: true, data: { summary: SUMMARY } });
    expect(core.undoStaffAlertsClear).toHaveBeenCalledWith(db, "staff_own", UNDO);
    expect(core.markAllStaffAlertsRead).not.toHaveBeenCalled();
    expect(core.markStaffAlertRead).not.toHaveBeenCalled();
  });

  it("maps whole-operation scope/revision conflicts to 409 without retrying scopes individually", async () => {
    const { request } = testApp();
    core.clearStaffAlerts.mockRejectedValueOnce(new ConflictError("Notification state changed"));
    core.undoStaffAlertsClear.mockRejectedValueOnce(new ConflictError("Notification state changed"));
    for (const [path, body] of [["/clear-all", CLEAR], ["/clear-all/undo", UNDO]] as const) {
      const response = await request(path, "POST", body);
      expect(response.status).toBe(409);
      expect(response.cache).toBe("private, no-store");
    }
    expect(core.clearStaffAlerts).toHaveBeenCalledOnce();
    expect(core.undoStaffAlertsClear).toHaveBeenCalledOnce();
    expect(core.markAllStaffAlertsRead).not.toHaveBeenCalled();
  });

  it("rejects unknown/duplicate/oversized scopes, unsafe frontiers and revision-less clears", async () => {
    const { request } = testApp();
    const invalid = [
      { ...CLEAR, userId: "staff_other" }, { ...CLEAR, operationId: " " }, { ...CLEAR, operationId: "x".repeat(129) },
      { ...CLEAR, through: -1 }, { ...CLEAR, through: 9007199254740992 }, { ...CLEAR, scopes: [] },
      { ...CLEAR, scopes: [{ scope: "orders", revision: 3 }, { scope: "orders", revision: 3 }] },
      { ...CLEAR, scopes: [{ scope: "settings", revision: 3 }] }, { ...CLEAR, scopes: [{ scope: "orders" }] },
      { ...CLEAR, scopes: [{ scope: "orders", revision: -1 }] },
    ];
    for (const body of invalid) expect((await request("/clear-all", "POST", body)).status).toBe(400);
    expect((await request("/read-all", "POST", { through: 111, scopes: ["orders", "orders"] })).status).toBe(400);
    expect((await request("/clear-all/undo", "POST", { ...UNDO, through: 111 })).status).toBe(400);
    expect(core.clearStaffAlerts).not.toHaveBeenCalled();
    expect(core.undoStaffAlertsClear).not.toHaveBeenCalled();
    expect(core.markAllStaffAlertsRead).not.toHaveBeenCalled();
  });

  it("classifies only the six explicit staff routes and excludes personal state from agent execution", () => {
    const document = testApp().app.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "test", version: "1" } });
    for (const [method, suffix, name] of endpoints) {
      const path = `/api/v1/admin/notifications${suffix}`;
      expect(getRoutePermission(path, method)).toEqual({ allowAnyAdmin: true });
      const operationId = `dashboard.notifications.${name}` as const;
      expect(DASHBOARD_SETTINGS_OPERATIONS[operationId]).toMatchObject({ exposure: "excluded" });
      const documentedPath = path.replace("/111/read", "/{seq}/read");
      expect(document.paths?.[documentedPath || "/"]).toMatchObject({ [method.toLowerCase()]: { operationId } });
    }
    expect(getRoutePermission("/api/v1/admin/notifications/clear-all", "DELETE")).toBeNull();
    expect(document.paths?.["/api/v1/admin/notifications/clear-all"]?.post?.responses).toHaveProperty("409");
    expect(document.paths?.["/api/v1/admin/notifications/clear-all/undo"]?.post?.responses).toHaveProperty("409");
  });
});
