// An app permanently deletes only the trashed content it created itself
// (`dashboard.resources.app_content.delete`), under the staff delete rules.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";
import { adminResourceProductRoutes } from "./resources-products";

let sqlite: DatabaseSync;
let db: Database;
const PERMISSIONS = new Set(["products.delete", "categories.delete", "collections.delete", "media.delete"]);

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);`);
});
afterEach(() => sqlite.close());

async function call(body: unknown, plugin: { pluginId: string; permissions: Set<string> } | null = { pluginId: "acme.demo", permissions: PERMISSIONS }) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    if (plugin) c.set("pluginPrincipal" as never, plugin as never);
    await next();
  });
  app.route("/resources", adminResourceProductRoutes);
  app.onError((error, c) => { const { body: errorBody, status } = errorResponseFromError(error); return c.json(errorBody, status); });
  const response = await app.request("/api/v1/admin/resources/app-content/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, {} as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
  return { status: response.status, body: await response.json() as { data: any; error: { code: string } } };
}

function brand(id: string, trashed: boolean, owner: string | null) {
  sqlite.exec(`INSERT INTO brands (id, name, slug, status, revision, deleted_at) VALUES ('${id}', '${id}', '${id.replace(/_/g, "-")}', 'draft', 1, ${trashed ? "unixepoch()" : "NULL"});`);
  if (owner) sqlite.exec(`INSERT INTO app_resource_owners (resource_type, resource_id, plugin_id) VALUES ('brand', '${id}', '${owner}');`);
}

describe("an app's own trashed content", () => {
  it("is deleted permanently; staff-made, another app's and live items are left", async () => {
    brand("brd_own0001", true, "acme.demo");
    brand("brd_live0001", false, "acme.demo");
    brand("brd_staff001", true, null);
    brand("brd_other001", true, "other.app");
    const result = await call({ items: [
      { type: "brand", id: "brd_own0001", expectedRevision: 1 },
      { type: "brand", id: "brd_live0001", expectedRevision: 1 },
      { type: "brand", id: "brd_staff001", expectedRevision: 1 },
      { type: "brand", id: "brd_other001", expectedRevision: 1 },
      { type: "brand", id: "brd_gone0001", expectedRevision: 1 },
    ] });
    expect(result.status).toBe(200);
    expect(result.body.data.items.map((item: { id: string; outcome: string }) => [item.id, item.outcome])).toEqual([
      ["brd_own0001", "deleted"],
      ["brd_live0001", "not_in_trash"],
      ["brd_staff001", "not_owned"],
      ["brd_other001", "not_owned"],
      ["brd_gone0001", "not_owned"],
    ]);
    const left = sqlite.prepare("SELECT id FROM brands ORDER BY id").all().map((row) => (row as { id: string }).id);
    expect(left).toEqual(["brd_live0001", "brd_other001", "brd_staff001"]);
    expect(sqlite.prepare("SELECT resource_id FROM app_resource_owners WHERE resource_id = 'brd_own0001'").all()).toEqual([]);
  });

  it("names a stale revision a conflict and keeps the item", async () => {
    brand("brd_own0001", true, "acme.demo");
    const result = await call({ items: [{ type: "brand", id: "brd_own0001", expectedRevision: 7 }] });
    expect(result.body.data.items[0].outcome).toBe("conflict");
    expect(sqlite.prepare("SELECT count(*) AS n FROM brands").get()).toEqual({ n: 1 });
  });

  it("checks the grant per type, and refuses staff and agents", async () => {
    brand("brd_own0001", true, "acme.demo");
    const narrow = await call({ items: [{ type: "brand", id: "brd_own0001", expectedRevision: 1 }] }, { pluginId: "acme.demo", permissions: new Set(["media.delete"]) });
    expect(narrow.body.data.items[0].outcome).toBe("forbidden");
    const staff = await call({ items: [{ type: "brand", id: "brd_own0001", expectedRevision: 1 }] }, null);
    expect(staff.status).toBe(403);
    expect(staff.body.error.code).toBe("app_only");
  });
});
