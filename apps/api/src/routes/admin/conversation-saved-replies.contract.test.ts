import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";
import { adminConversationSavedReplyRoutes } from "./conversation-saved-replies";

let sqlite: DatabaseSync;
let db: Database;
const base = "/api/v1/admin/conversations";
const input = { id: "saved_shipping", title: "Shipping", body: "Ships tomorrow.", mode: "reply" };

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role) VALUES
    ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin'),
    ('staff_2', 'Amina', 'amina@shop.test', 1, 'admin')`);
});
afterEach(() => sqlite.close());

function app(userId: string | null = "staff_1") {
  const router = new OpenAPIHono<{ Bindings: Env }>();
  router.use("*", async (c, next) => {
    c.set("db", db);
    if (userId) c.set("user" as never, { id: userId } as never);
    await next();
  });
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  router.route(base, adminConversationSavedReplyRoutes);
  return router;
}

function request(method: string, path = "/saved-replies", body?: unknown, userId: string | null = "staff_1") {
  return app(userId).request(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

describe("saved reply API contracts", () => {
  it("creates and replays the exact private row without posting a message", async () => {
    const first = await request("POST", "/saved-replies", input);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await first.json();
    expect(payload).toMatchObject({ success: true, data: { ...input, createdBy: "staff_1", updatedBy: "staff_1", archivedAt: null, version: 1 } });
    const replay = await request("POST", "/saved-replies", input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(payload);
    expect((await request("POST", "/saved-replies", { ...input, body: "Changed" })).status).toBe(409);
    expect((await request("POST", "/saved-replies", input, "staff_2")).status).toBe(409);
    expect(sqlite.prepare("SELECT count(*) AS n FROM conversation_messages").get()).toEqual({ n: 0 });
  });

  it("filters active replies by mode and title, while exact reads expose archived selections", async () => {
    await request("POST", "/saved-replies", input);
    await request("POST", "/saved-replies", { ...input, id: "saved_note", title: "Warehouse", mode: "note" });
    const listed = await request("GET", "/saved-replies?mode=reply&q=Shipping");
    expect(await listed.json()).toMatchObject({ data: { items: [{ id: input.id }], nextCursor: null } });
    const bodySearch = await request("GET", "/saved-replies?q=tomorrow");
    expect(await bodySearch.json()).toMatchObject({ data: { items: [] } });
    const archived = await request("PATCH", `/saved-replies/${input.id}`, { version: 1, archived: true });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ data: { version: 2, archivedAt: expect.any(Number) } });
    const exact = await request("GET", `/saved-replies/${input.id}`);
    expect(exact.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await exact.json()).toMatchObject({ data: { id: input.id, version: 2, archivedAt: expect.any(Number) } });
    expect(await (await request("GET", "/saved-replies?mode=reply")).json()).toMatchObject({ data: { items: [] } });
    expect((await request("PATCH", `/saved-replies/${input.id}`, { version: 1, archived: false })).status).toBe(409);
    expect((await request("PATCH", `/saved-replies/${input.id}`, { version: 2, archived: false })).status).toBe(200);
  });

  it("requires a staff identity on reads and writes, including before body validation", async () => {
    for (const [method, path, body] of [
      ["GET", "/saved-replies", undefined],
      ["GET", `/saved-replies/${input.id}`, undefined],
      ["POST", "/saved-replies", {}],
      ["PATCH", `/saved-replies/${input.id}`, {}],
    ] as const) {
      const response = await request(method, path, body, null);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("refuses invalid fields, stale versions and unknown ids without altering saved content", async () => {
    await request("POST", "/saved-replies", input);
    for (const body of [{ version: 1 }, { version: 1, mode: "note" }, { version: 1, body: " " }, { version: 0, body: "Changed" }]) {
      const response = await request("PATCH", `/saved-replies/${input.id}`, body);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect((await request("GET", "/saved-replies?cursor=bad")).status).toBe(400);
    expect((await request("GET", `/saved-replies?q=${"x".repeat(101)}`)).status).toBe(400);
    expect((await request("GET", "/saved-replies/missing")).status).toBe(404);
    expect((await request("PATCH", "/saved-replies/missing", { version: 1, body: "Hello" })).status).toBe(404);
    expect(await (await request("GET", `/saved-replies/${input.id}`)).json()).toMatchObject({ data: { ...input, version: 1 } });
  });

  it("requires conversations.reply for every saved reply operation", () => {
    for (const [method, path] of [
      ["GET", `${base}/saved-replies`],
      ["POST", `${base}/saved-replies`],
      ["GET", `${base}/saved-replies/${input.id}`],
      ["PATCH", `${base}/saved-replies/${input.id}`],
    ] as const) {
      expect(getRoutePermission(path!, method!)).toEqual({ permission: PERMISSIONS.CONVERSATIONS_REPLY });
    }
  });

  it("documents the exact operations and durable row fields for generated clients", () => {
    const spec = app().getOpenAPIDocument({ openapi: "3.0.0", info: { title: "Saved replies", version: "test" } });
    expect(spec.paths?.[`${base}/saved-replies`]?.get?.operationId).toBe("dashboard.conversations.saved_replies.list");
    expect(spec.paths?.[`${base}/saved-replies`]?.post?.operationId).toBe("dashboard.conversations.saved_replies.create");
    expect(spec.paths?.[`${base}/saved-replies/{replyId}`]?.get?.operationId).toBe("dashboard.conversations.saved_replies.get");
    expect(spec.paths?.[`${base}/saved-replies/{replyId}`]?.patch?.operationId).toBe("dashboard.conversations.saved_replies.update");
    const serialized = JSON.stringify(spec.paths?.[`${base}/saved-replies/{replyId}`]?.get?.responses?.["200"]);
    expect(serialized).toContain('"archivedAt"');
    expect(serialized).toContain('"version"');
    expect(serialized).toContain('"createdBy"');
  });
});
