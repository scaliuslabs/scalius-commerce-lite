import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { objectTypeDeclarationSchema } from "@scalius/shared/plugins/objects";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { syncAppObjectTypes } from "@scalius/core/modules/objects";
import { errorResponseFromError } from "../../utils/api-response";
import { classifyAdminRuntimePath } from "../../runtime/admin-app";
import { AGENT_OPERATION_ID_PATTERN } from "../../openapi/agent-operation-manifest";
import { operationMetadata, operationSurface, registryEntry } from "../../openapi/operation-registry";
import { adminObjectRoutes, objectFieldsJsonSchema, objectWhereQuery } from "./objects";

let sqlite: DatabaseSync;
let db: Database;
let principal: { pluginId: string } | null;

beforeEach(() => { ({ sqlite, db } = createSqliteD1Database()); principal = null; });
afterEach(() => sqlite.close());

async function call(method: string, path: string, body?: unknown) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => { c.set("db", db as never); if (principal) c.set("pluginPrincipal", principal as never); await next(); });
  app.route("/objects", adminObjectRoutes);
  app.onError((error, c) => { const { body, status } = errorResponseFromError(error); return c.json(body, status); });
  const response = await app.request(`/api/v1/admin/objects${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
  return { status: response.status, cache: response.headers.get("cache-control"), body: response.status === 204 ? null : await response.json() as { data: any; error: { code: string; message: string } } };
}

const FAQ = {
  name: "FAQ", fields: [
    { key: "question", name: "Question", type: "single_line_text", required: true },
    { key: "answer", name: "Answer", type: "multi_line_text" },
    { key: "customer", name: "Customer", type: "customer_reference" },
  ], indexes: ["customer"], storefront: true, handle: true, admin: "edit" as const,
};

describe("object operations", () => {
  it("discovers the schema and round-trips records with required revision guards", async () => {
    const created = await call("POST", "/types", { type: "faq", ...FAQ });
    expect(created.status).toBe(201);
    expect(created.body!.data.type).toMatchObject({ handle: "custom.faq", owner: "merchant", admin: "edit" });
    const schema = await call("GET", "/types/custom.faq");
    expect(schema.cache).toBe("private, no-store");
    expect(schema.body!.data.jsonSchema).toMatchObject({ required: ["question"], properties: { customer: { type: "string" } } });
    const draft = await call("PUT", "/custom.faq/faq_1", { expectedRevision: null, handle: "returns", data: { question: "Returns?", customer: "cus_1" } });
    expect(draft.status).toBe(200);
    expect(draft.body!.data.record).toMatchObject({ id: "faq_1", revision: 1, data: { question: "Returns?" } });
    expect((await call("PUT", "/custom.faq/faq_1", { data: {} })).status).toBe(400);
    expect((await call("PUT", "/custom.faq/faq_1", { expectedRevision: null, data: { question: "Duplicate" } })).status).toBe(409);
    expect((await call("PUT", "/custom.faq/faq_1", { expectedRevision: 1, data: { question: "Within seven days" } })).status).toBe(200);
    expect((await call("DELETE", "/custom.faq/faq_1?expectedRevision=1")).status).toBe(409);
    expect((await call("GET", "/custom.faq")).body!.data.records).toHaveLength(1);
    const deleted = await call("DELETE", "/custom.faq/faq_1?expectedRevision=2");
    expect(deleted.status).toBe(200);
    expect(deleted.body!.data).toEqual({ id: "faq_1", deleted: true });
    expect((await call("GET", "/custom.faq")).body!.data).toEqual({ records: [], nextCursor: null });
    const type = (await call("GET", "/types/custom.faq")).body!.data.type;
    expect((await call("DELETE", `/types/custom.faq?expectedRevision=${type.revision}`)).body!.data).toEqual({ id: type.id, deleted: true });
  });

  it("bounds serialized list pages and continues after the last emitted record", async () => {
    await call("POST", "/types", { type: "large", name: "Large records", fields: [{ key: "payload", name: "Payload", type: "json" }] });
    for (const id of ["one", "two", "three", "four"]) {
      expect((await call("PUT", `/custom.large/${id}`, { expectedRevision: null, data: { payload: "x".repeat(40_000) } })).status).toBe(200);
    }
    const first = await call("GET", "/custom.large?limit=100");
    expect(first.status).toBe(200);
    expect(new TextEncoder().encode(JSON.stringify(first.body)).byteLength).toBeLessThan(128 * 1024);
    expect(first.body!.data.records.length).toBeGreaterThan(0);
    expect(first.body!.data.records.length).toBeLessThan(4);
    const second = await call("GET", `/custom.large?limit=100&cursor=${first.body!.data.nextCursor}`);
    const ids = [...first.body!.data.records, ...second.body!.data.records].map((record: { id: string }) => record.id);
    expect(ids.sort()).toEqual(["four", "one", "three", "two"]);
    expect(second.body!.data.nextCursor).toBeNull();
  });

  it("hides private app types and prevents manifest edits or writes to read-only types", async () => {
    await syncAppObjectTypes(db, "acme.loyalty", { hidden: objectTypeDeclarationSchema.parse({ ...FAQ, admin: "none" }), history: objectTypeDeclarationSchema.parse({ ...FAQ, admin: "read" }) });
    const listed = await call("GET", "/types");
    expect(listed.body!.data.types.map((item: { handle: string }) => item.handle)).toEqual(["acme.loyalty.history"]);
    expect(listed.body!.data.nextCursor).toBeNull();
    expect((await call("GET", "/types/acme.loyalty.hidden")).status).toBe(404);
    expect((await call("GET", "/acme.loyalty.hidden")).status).toBe(404);
    expect((await call("PUT", "/acme.loyalty.history/one", { expectedRevision: null, data: { question: "Hi" } })).status).toBe(403);
    expect((await call("PATCH", "/types/acme.loyalty.history", { ...FAQ, expectedRevision: 1 })).status).toBe(403);
    principal = { pluginId: "acme.other" };
    expect((await call("GET", "/types")).body!.data.types).toEqual([]);
    expect((await call("GET", "/acme.loyalty.history")).status).toBe(403);
  });

  it("keeps object operations admin-only under exact registered ids and route permissions", () => {
    for (const id of ["objects.types.list", "objects.types.get", "objects.types.create", "objects.types.update", "objects.types.delete", "objects.list", "objects.get", "objects.upsert", "objects.delete"]) {
      expect(AGENT_OPERATION_ID_PATTERN.test(id)).toBe(true);
      expect(operationSurface(id)).toBe("dashboard");
    }
    expect(() => operationSurface("objects.unreviewed")).toThrow();
    expect(AGENT_OPERATION_ID_PATTERN.test("objects.unreviewed")).toBe(false);
    const entry = registryEntry("objects.upsert")!;
    expect(operationMetadata("objects.upsert", "PUT", entry)).toMatchObject({ surface: "dashboard", principals: ["admin"], risk: "write", revision: "required" });
    expect(getRoutePermission("/api/v1/admin/objects/types", "GET")?.permission).toBe(PERMISSIONS.OBJECTS_VIEW);
    expect(getRoutePermission("/api/v1/admin/objects/types", "POST")?.permission).toBe(PERMISSIONS.OBJECTS_EDIT);
    expect(getRoutePermission("/api/v1/admin/objects/custom.faq/one", "PUT")?.permission).toBe(PERMISSIONS.OBJECTS_EDIT);
    expect(classifyAdminRuntimePath("/api/v1/admin/objects/types")).toBe("content");
  });

  it("parses indexed filters without accepting duplicate or nested values", () => {
    expect(objectWhereQuery("https://api.test/?where[customer]=cus_1")).toEqual({ customer: "cus_1" });
    expect(objectWhereQuery("https://api.test/?where=%7B%22score%22%3A2%7D")).toEqual({ score: 2 });
    expect(() => objectWhereQuery("https://api.test/?where[customer]=1&where[customer]=2")).toThrow();
    expect(() => objectWhereQuery("https://api.test/?where=%7B%22customer%22%3A%7B%7D%7D")).toThrow();
    expect(objectFieldsJsonSchema([{ key: "tags", name: "Tags", type: "list.single_line_text", required: false, validations: {} }])).toMatchObject({ properties: { tags: { type: "array", items: { type: "string" } } } });
  });
});
