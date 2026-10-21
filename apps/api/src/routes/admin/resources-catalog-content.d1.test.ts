// Categories, collections and brands in the stable app API: one resource
// shape per type, read by `categories.get`/`collections.get` (and listed by
// cursor), and answered by every write (`{ category }`, `{ collection }`,
// `{ brand }`, `{ brands }`), each write under the `expectedRevision` read.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";
import { adminResourceCatalogContentRoutes } from "./resources-catalog-content";
import { adminCategoryRoutes } from "./categories";
import { adminCollectionRoutes } from "./collections";
import { adminBrandRoutes } from "./brands";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
});
afterEach(() => sqlite.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
type Wire = { status: number; body: { data: any; error: { code: string; message: string } } };

async function call(method: string, path: string, body?: unknown): Promise<Wire> {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/resources", adminResourceCatalogContentRoutes);
  app.route("/categories", adminCategoryRoutes);
  app.route("/collections", adminCollectionRoutes);
  app.route("/brands", adminBrandRoutes);
  app.onError((error, c) => { const { body: errorBody, status } = errorResponseFromError(error); return c.json(errorBody, status); });
  const response = await app.request(`/api/v1/admin${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, {} as never);
  return { status: response.status, body: await response.json() as Wire["body"] };
}

const category = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: null, metaTitle: null, metaDescription: null, image: null, ...extra,
});

describe("categories as a resource", () => {
  it("answers every write with the category categories.get reads, under the revision read", async () => {
    const created = await call("POST", "/categories", category("Tea", { slug: "tea" }));
    expect(created.status).toBe(201);
    const { category: tea } = created.body.data;
    expect(tea).toMatchObject({ name: "Tea", slug: "tea", status: "draft", revision: 1, parentId: null, depth: 0, deletedAt: null });
    expect(tea.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect((await call("GET", `/resources/categories/${tea.id}`)).body.data).toEqual({ category: tea });

    const stale = await call("PUT", `/categories/${tea.id}`, category("Green tea", { slug: "tea", expectedRevision: 9, status: "draft" }));
    expect(stale.status).toBe(409);
    const updated = await call("PUT", `/categories/${tea.id}`, category("Green tea", { slug: "tea", expectedRevision: 1, status: "draft" }));
    expect(updated.status).toBe(200);
    expect(updated.body.data.category).toMatchObject({ id: tea.id, name: "Green tea", revision: 2 });

    // Trash takes the revision in the query (a DELETE has no body) and answers the trashed category.
    expect((await call("DELETE", `/categories/${tea.id}`)).status).toBe(400);
    expect((await call("DELETE", `/categories/${tea.id}?expectedRevision=1`)).status).toBe(409);
    const trashed = await call("DELETE", `/categories/${tea.id}?expectedRevision=2`);
    expect(trashed.status).toBe(200);
    expect(trashed.body.data.category.deletedAt).not.toBeNull();
    const restored = await call("POST", `/categories/${tea.id}/restore`, { expectedRevision: trashed.body.data.category.revision });
    expect(restored.status).toBe(200);
    expect(restored.body.data.category).toMatchObject({ id: tea.id, deletedAt: null, status: "draft" });
  });

  it("lists by cursor in (updatedAt, id) order, one tree level with parentId", async () => {
    const root = (await call("POST", "/categories", category("Drinks", { slug: "drinks" }))).body.data.category;
    await call("POST", "/categories", category("Coffee", { slug: "coffee", parentId: root.id }));
    await call("POST", "/categories", category("Juice", { slug: "juice", parentId: root.id }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Wire = await call("GET", `/resources/categories?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      expect(Object.keys(page.body.data).sort()).toEqual(["categories", "nextCursor"]);
      seen.push(...page.body.data.categories.map((each: { slug: string }) => each.slug));
      cursor = page.body.data.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(["coffee", "drinks", "juice"]);
    const children = (await call("GET", `/resources/categories?parentId=${root.id}`)).body.data.categories;
    expect(children.map((each: { slug: string }) => each.slug).sort()).toEqual(["coffee", "juice"]);
    expect((await call("GET", "/resources/categories?parentId=root")).body.data.categories.map((each: { slug: string }) => each.slug)).toEqual(["drinks"]);
    expect((await call("GET", "/resources/categories/cat_missing")).status).toBe(404);
  });
});

describe("collections as a resource", () => {
  const collection = { name: "Hot deals", slug: "hot-deals", presentation: "grid", isActive: false, config: { source: "manual" } };

  it("answers every write with the collection collections.get reads, under expectedRevision", async () => {
    const created = await call("POST", "/collections", collection);
    expect(created.status).toBe(201);
    const hot = created.body.data.collection;
    expect(hot).toMatchObject({ name: "Hot deals", slug: "hot-deals", revision: 1, isActive: false, deletedAt: null });
    expect(hot.config).toEqual({ source: "manual", productIds: [], categoryIds: [], featuredProductId: null, maxProducts: 8, title: "", subtitle: "" });
    expect(hot).not.toHaveProperty("version");
    expect((await call("GET", `/resources/collections/${hot.id}`)).body.data).toEqual({ collection: hot });

    expect((await call("PUT", `/collections/${hot.id}`, { expectedVersion: 1, name: "Hotter deals" })).status).toBe(400);
    expect((await call("PUT", `/collections/${hot.id}`, { expectedRevision: 2, name: "Hotter deals" })).status).toBe(409);
    const updated = await call("PUT", `/collections/${hot.id}`, { expectedRevision: 1, name: "Hotter deals" });
    expect(updated.status).toBe(200);
    expect(updated.body.data.collection).toMatchObject({ id: hot.id, name: "Hotter deals", revision: 2 });
    const products = await call("POST", `/collections/${hot.id}/products`, { expectedRevision: 2, add: [] });
    expect(products.status).toBe(200);
    expect(products.body.data.collection.revision).toBe(3);

    // Trash and restore require the revision, as every other trash does.
    expect((await call("DELETE", `/collections/${hot.id}`)).status).toBe(400);
    expect((await call("DELETE", `/collections/${hot.id}?expectedRevision=1`)).status).toBe(409);
    const trashed = await call("DELETE", `/collections/${hot.id}?expectedRevision=3`);
    expect(trashed.status).toBe(200);
    expect(trashed.body.data.collection.deletedAt).not.toBeNull();
    expect((await call("POST", `/collections/${hot.id}/restore`, {})).status).toBe(400);
    const restored = await call("POST", `/collections/${hot.id}/restore`, { expectedRevision: trashed.body.data.collection.revision });
    expect(restored.status).toBe(200);
    expect(restored.body.data.collection).toMatchObject({ id: hot.id, deletedAt: null });
  });

  it("lists by cursor, trashed ones apart", async () => {
    for (const slug of ["one", "two", "three"]) await call("POST", "/collections", { ...collection, name: `Deals ${slug}`, slug: `deals-${slug}` });
    const first = await call("GET", "/resources/collections?limit=2");
    expect(first.body.data.collections).toHaveLength(2);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    const rest = await call("GET", `/resources/collections?limit=2&cursor=${first.body.data.nextCursor}`);
    expect(rest.body.data).toMatchObject({ nextCursor: null });
    expect([...first.body.data.collections, ...rest.body.data.collections].map((each: { slug: string }) => each.slug).sort())
      .toEqual(["deals-one", "deals-three", "deals-two"]);
    expect((await call("GET", "/resources/collections?trashed=true")).body.data).toEqual({ collections: [], nextCursor: null });
  });
});

describe("brands answer the brand", () => {
  it("answers updates with { brand }, trash and restore with { brands }, under the revision read", async () => {
    const created = await call("POST", "/brands", { name: "Volt" });
    expect(created.status).toBe(201);
    const volt = created.body.data.brand;
    expect(volt).toMatchObject({ name: "Volt", slug: "volt", revision: 1, status: "draft", productCount: 0 });
    expect((await call("GET", `/brands/${volt.id}`)).body.data).toEqual({ brand: volt });
    expect((await call("PATCH", `/brands/${volt.id}/status`, { status: "published", expectedRevision: 5 })).status).toBe(409);
    const published = await call("PATCH", `/brands/${volt.id}/status`, { status: "published", expectedRevision: 1 });
    expect(published.body.data.brand).toMatchObject({ id: volt.id, status: "published", revision: 2 });
    const trashed = await call("POST", "/brands/trash", { brands: [{ id: volt.id, expectedRevision: 2 }] });
    expect(trashed.status).toBe(200);
    expect(trashed.body.data.brands).toHaveLength(1);
    expect(trashed.body.data.brands[0]).toMatchObject({ id: volt.id });
    expect(trashed.body.data.brands[0].deletedAt).not.toBeNull();
  });
});

describe("brands and pages list by cursor", () => {
  it("walks brands in (updatedAt, id) order, filtered by status, updatedSince and the trash", async () => {
    for (const name of ["Volt", "Amp", "Ohm"]) expect((await call("POST", "/brands", { name })).status).toBe(201);
    const amp = (await call("GET", "/resources/brands?limit=50")).body.data.brands.find((each: { slug: string }) => each.slug === "amp");
    await call("PATCH", `/brands/${amp.id}/status`, { status: "published", expectedRevision: 1 });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Wire = await call("GET", `/resources/brands?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      expect(Object.keys(page.body.data).sort()).toEqual(["brands", "nextCursor"]);
      seen.push(...page.body.data.brands.map((each: { slug: string }) => each.slug));
      cursor = page.body.data.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(["amp", "ohm", "volt"]);
    const published = (await call("GET", "/resources/brands?status=published")).body.data.brands;
    expect(published).toEqual([(await call("GET", `/brands/${amp.id}`)).body.data.brand]);
    expect((await call("GET", "/resources/brands?updatedSince=2999-01-01T00:00:00Z")).body.data).toEqual({ brands: [], nextCursor: null });
    expect((await call("GET", "/resources/brands?trashed=true")).body.data).toEqual({ brands: [], nextCursor: null });
  });

  it("walks content pages and articles, filtered by type, updatedSince and the trash", async () => {
    sqlite.exec(`
      INSERT INTO pages (id, content_type, title, slug, content, updated_at) VALUES
        ('pg_about', 'page', 'About us', 'about-us', '<p>Hello</p>', 100),
        ('pg_post', 'article', 'Launch', 'launch', '<p>News</p>', 200),
        ('pg_old', 'page', 'Old', 'old', '<p>Gone</p>', 300);
      UPDATE pages SET deleted_at = 400 WHERE id = 'pg_old';
    `);
    const first = await call("GET", "/resources/pages?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.data.pages.map((each: { id: string }) => each.id)).toEqual(["pg_about"]);
    expect(first.body.data.pages[0]).toMatchObject({ contentType: "page", title: "About us", slug: "about-us", revision: 1, deletedAt: null });
    const rest = await call("GET", `/resources/pages?limit=5&cursor=${first.body.data.nextCursor}`);
    expect(rest.body.data).toMatchObject({ nextCursor: null });
    expect(rest.body.data.pages.map((each: { id: string }) => each.id)).toEqual(["pg_post"]);
    expect((await call("GET", "/resources/pages?contentType=article")).body.data.pages.map((each: { id: string }) => each.id)).toEqual(["pg_post"]);
    expect((await call("GET", "/resources/pages?updatedSince=1970-01-01T00:03:00Z")).body.data.pages.map((each: { id: string }) => each.id)).toEqual(["pg_post"]);
    expect((await call("GET", "/resources/pages?trashed=true")).body.data.pages.map((each: { id: string }) => each.id)).toEqual(["pg_old"]);
  });
});
