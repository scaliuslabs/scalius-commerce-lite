// The stable app API's whole-menu writes (`menus.get`, `menus.create`,
// `menus.update`): a menu and all its links in one write, handles resolved,
// links replaced under the revision read, and publishing in the same call
// (a refused publish leaves the saved links unpublished and says why).
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";
import { adminResourceMenuRoutes } from "./resources-menus";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_laptops', 'Laptops', 'laptops', 'published');
    INSERT INTO collections (id, name, slug, presentation, config, is_active) VALUES ('col_hot', 'Hot deals', 'hot-deals', 'grid', '{"source":"manual","productIds":[]}', 0);`);
});
afterEach(() => sqlite.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
type Wire = { status: number; body: { data: any; error: { code: string; message: string } } };

async function call(method: string, path: string, body?: unknown): Promise<Wire> {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    c.set("pluginPrincipal" as never, { pluginId: "acme.look", permissions: new Set(["settings.header.edit"]) } as never);
    await next();
  });
  app.route("/resources", adminResourceMenuRoutes);
  app.onError((error, c) => { const { body: errorBody, status } = errorResponseFromError(error); return c.json(errorBody, status); });
  const response = await app.request(`/api/v1/admin/resources${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, {} as never);
  return { status: response.status, body: await response.json() as Wire["body"] };
}

const footer = [
  { key: "help", label: "Help", target: { type: "label" } },
  { key: "about", parentKey: "help", label: "About us", target: { type: "internal_path", path: "/about" } },
  { key: "laptops", parentKey: "help", label: "Laptops", target: { type: "resource", resourceType: "category", handle: "laptops" } },
  { key: "home", label: "Home", target: { type: "system", key: "home" } },
];

describe("menus.create", () => {
  it("creates the menu with its links in tree order, resolves handles and publishes", async () => {
    const created = await call("POST", "/menus", { name: "Footer help", items: footer, publish: true });
    expect(created.status).toBe(201);
    const { menu } = created.body.data;
    expect(created.body.data).toMatchObject({ published: true, publishError: null });
    expect(menu).toMatchObject({ handle: "footer-help", revision: 2, publishedRevision: 2 });
    expect(menu.items.map((item: { label: string }) => item.label)).toEqual(["Help", "About us", "Laptops", "Home"]);
    expect(menu.items[1].parentId).toBe(menu.items[0].id);
    expect(menu.items[2].target).toEqual({ type: "resource", resourceType: "category", resourceId: "cat_laptops", query: null });
    expect((await call("GET", "/menus/footer-help")).body.data.menu.id).toBe(menu.id);
  });

  it("refuses an unknown handle, a fourth level, a child before its parent and a taken handle", async () => {
    const level = (key: string, parentKey?: string) => ({ key, ...(parentKey ? { parentKey } : {}), label: key, target: { type: "label" } });
    expect((await call("POST", "/menus", { name: "A", items: [{ key: "x", label: "X", target: { type: "resource", resourceType: "collection", handle: "nope" } }] })).body.error.code).toBe("handle_unresolved");
    expect((await call("POST", "/menus", { name: "B", items: [level("a"), level("b", "a"), level("c", "b"), level("d", "c")] })).status).toBe(400);
    expect((await call("POST", "/menus", { name: "C", items: [level("b", "a"), level("a")] })).status).toBe(400);
    expect((await call("POST", "/menus", { name: "Main" })).status).toBe(201);
    expect((await call("POST", "/menus", { name: "Main" })).status).toBe(409);
    expect(sqlite.prepare("SELECT count(*) AS n FROM navigation_menus").get()).toEqual({ n: 1 });
  });
});

describe("menus.update", () => {
  it("replaces the links under the revision read, once, and reports a refused publish", async () => {
    const { menu } = (await call("POST", "/menus", { name: "Footer", items: footer })).body.data;
    const stale = await call("PATCH", `/menus/${menu.id}`, { expectedRevision: menu.revision + 1, items: [] });
    expect(stale.status).toBe(409);
    // A link to an inactive collection saves, but cannot be published.
    const replaced = await call("PATCH", `/menus/${menu.id}`, {
      expectedRevision: menu.revision,
      name: "Footer links",
      items: [{ key: "deals", label: "Deals", target: { type: "resource", resourceType: "collection", handle: "hot-deals" } }],
      publish: true,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.published).toBe(false);
    expect(replaced.body.data.publishError.code).toBe("validation_error");
    expect(replaced.body.data.menu).toMatchObject({ name: "Footer links", revision: menu.revision + 1, publishedRevision: null });
    expect(replaced.body.data.menu.items.map((item: { label: string }) => item.label)).toEqual(["Deals"]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM navigation_menu_items").get()).toEqual({ n: 1 });
  });
});
