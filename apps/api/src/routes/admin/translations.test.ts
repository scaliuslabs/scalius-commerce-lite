// Settings → Languages and Translate & adapt (MARKETS-DESIGN D9): the routes
// over a migrated database, each translation gated by the permission of the
// kind of resource it translates.
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { errorResponseFromError } from "../../utils/api-response";
import { languagesSettingsRoutes } from "./settings/languages";
import { adminTranslationRoutes } from "./translations";

const granted = vi.hoisted(() => new Set<string>());
vi.mock("@scalius/core/auth/rbac/helpers", async (load) => ({
  ...await load<typeof import("@scalius/core/auth/rbac/helpers")>(),
  hasPermission: vi.fn(async (_db: unknown, _user: string, permission: string) => granted.has(permission)),
}));

function createApp() {
  const { sqlite, db } = createSqliteD1Database();
  sqlite.exec(`INSERT INTO products (id, name, description, price_minor, slug, is_active) VALUES
    ('p_tee', 'Tee', '<p>Cotton tee.</p>', 50000, 'tee', 1), ('p_cap', 'Cap', NULL, 20000, 'cap', 1)`);
  const env = {} as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("user" as never, { id: "user_1" } as never);
    await next();
  });
  app.route("/admin/settings/languages", languagesSettingsRoutes);
  app.route("/admin/translations", adminTranslationRoutes);
  const call = (path: string, init: { method?: string; body?: unknown } = {}) => app.request(`/api/v1${path}`, {
    method: init.method ?? "GET",
    ...(init.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
  }, env);
  return { call, sqlite };
}

beforeEach(() => {
  granted.clear();
});

describe("Settings → Languages", () => {
  it("adds, publishes and removes a language; the default stays published", async () => {
    const { call } = createApp();
    const added = await call("/admin/settings/languages", { method: "POST", body: { locale: "bn" } });
    expect(added.status).toBe(201);
    await expect(added.json()).resolves.toMatchObject({ data: { language: { locale: "bn", published: false, isDefault: false } } });
    expect((await call("/admin/settings/languages", { method: "POST", body: { locale: "bn" } })).status).toBe(409);

    const published = await call("/admin/settings/languages/bn", { method: "PATCH", body: { published: true } });
    await expect(published.json()).resolves.toMatchObject({ data: { language: { published: true } } });
    expect((await call("/admin/settings/languages/en", { method: "PATCH", body: { published: false } })).status).toBe(400);

    const list = await (await call("/admin/settings/languages")).json() as { data: { items: Array<{ locale: string; isDefault: boolean }> } };
    expect(list.data.items.map((language) => [language.locale, language.isDefault])).toEqual([["en", true], ["bn", false]]);
    expect((await call("/admin/settings/languages/bn", { method: "DELETE" })).status).toBe(200);
  });
});

describe("Translate & adapt", () => {
  it("lists, saves and reads a product's translation for a viewer who may edit products", async () => {
    const { call } = createApp();
    await call("/admin/settings/languages", { method: "POST", body: { locale: "bn", published: true } });
    granted.add(PERMISSIONS.PRODUCTS_VIEW);

    const list = await call("/admin/translations/resources?type=product&locale=bn");
    expect(list.status).toBe(200);
    const listed = await list.json() as { data: { items: Array<{ id: string; status: string }>; total: number } };
    expect(listed.data.total).toBe(2);
    expect(listed.data.items.every((item) => item.status === "untranslated")).toBe(true);

    const body = { locale: "bn", fields: { name: "টি-শার্ট" }, slug: "ti-shirt" };
    expect((await call("/admin/translations/product/p_tee", { method: "PUT", body })).status).toBe(403);
    granted.add(PERMISSIONS.PRODUCTS_EDIT);
    const saved = await call("/admin/translations/product/p_tee", { method: "PUT", body });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ data: { resource: { status: "partial", slug: "ti-shirt", translation: { fields: { name: "টি-শার্ট" } } } } });

    // Another product's handle is refused.
    expect((await call("/admin/translations/product/p_cap", { method: "PUT", body: { locale: "bn", fields: {}, slug: "tee" } })).status).toBe(409);
    // Another kind needs its own permission.
    expect((await call("/admin/translations/resources?type=page&locale=bn")).status).toBe(403);
  });
});
