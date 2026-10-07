// Store migration routes on the real schema: the RBAC map of every path, the
// per-mode permission checks (create, upsert, price; creating categories and
// brands along the way), the request size ceiling, schema validation, and a
// dry run, write and paged export over HTTP.
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { errorResponseFromError } from "../../utils/api-response";
import { adminExportRoutes, adminImportRoutes } from "./store-transfer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { success: boolean; data: any; error?: any };

const ALL = Object.values(PERMISSIONS);

function createApp(permissions: readonly string[] = ALL) {
  const { sqlite, db } = createSqliteD1Database();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("user" as never, { id: "usr_import" } as never);
    c.set("adminPermissions" as never, new Set(permissions) as never);
    c.env = { SCALIUS_SECRET: "test-master-secret-that-is-long-enough-123456" } as unknown as Env;
    await next();
  });
  app.route("/import", adminImportRoutes);
  app.route("/export", adminExportRoutes);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(`/api/v1/admin/import${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Envelope };
  };
  return { app, sqlite, post };
}

const product = (overrides: Record<string, unknown> = {}) => ({
  ref: "clay-mug",
  handle: "clay-mug",
  title: "Clay Mug",
  descriptionHtml: "<p>Handmade clay mug, 350 ml.</p>",
  brand: "Mati",
  categoryPath: ["Home", "Kitchen"],
  status: "active",
  seoTitle: null,
  seoDescription: null,
  options: [],
  variants: [{
    optionValues: [],
    sku: "MUG-350",
    price: 450,
    compareAtPrice: 500,
    cost: null,
    stock: 12,
    trackInventory: true,
    weightGrams: 420,
    barcode: null,
    requiresShipping: true,
    imageUrl: null,
  }],
  ...overrides,
});

describe("store transfer RBAC map", () => {
  it("maps every path to the permissions it needs", () => {
    expect(getRoutePermission("/api/v1/admin/import/products", "POST")).toEqual({ anyOf: [PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_EDIT] });
    expect(getRoutePermission("/api/v1/admin/import/product-images", "POST")).toEqual({ allOf: [PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.MEDIA_UPLOAD] });
    expect(getRoutePermission("/api/v1/admin/import/customers", "POST")).toEqual({ anyOf: [PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.CUSTOMERS_EDIT] });
    expect(getRoutePermission("/api/v1/admin/import/inventory", "POST")).toEqual({ permission: PERMISSIONS.PRODUCTS_EDIT });
    expect(getRoutePermission("/api/v1/admin/export/products", "GET")).toEqual({ permission: PERMISSIONS.PRODUCTS_VIEW });
    expect(getRoutePermission("/api/v1/admin/export/inventory", "GET")).toEqual({ permission: PERMISSIONS.PRODUCTS_VIEW });
    expect(getRoutePermission("/api/v1/admin/import/products", "GET")).toBeNull();
  });
});

describe("store transfer routes", () => {
  it("previews, writes and exports a product over HTTP", async () => {
    const { app, post } = createApp();
    const preview = await post("/products", { mode: "upsert", dryRun: true, items: [product()] });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      processed: 1,
      stoppedEarly: false,
      results: [{ ref: "clay-mug", status: "would_create" }],
      references: { brandsToCreate: ["Mati"], categoriesToCreate: ["Home", "Home > Kitchen"], attributesToCreate: [] },
    });
    const written = await post("/products", { mode: "upsert", items: [product()] });
    expect(written.body.data.results[0]).toMatchObject({ status: "created", slug: "clay-mug", aggregateRevision: 1 });
    const again = await post("/products", { mode: "upsert", items: [product()] });
    expect(again.body.data.results[0].status).toBe("unchanged");

    const exported = await app.request("/api/v1/admin/export/products?limit=10");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(exported.headers.get("X-Export-Item-Count")).toBe("1");
    expect(exported.headers.get("X-Export-Next-Cursor")).toBeNull();
    const bytes = new Uint8Array(await exported.arrayBuffer());
    // A UTF-8 byte order mark, so Excel opens Bangla text correctly.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv.startsWith("Handle,Title,Body (HTML)")).toBe(true);
    expect(csv).toContain("clay-mug,Clay Mug");
    expect(csv).toContain("Home > Kitchen");
  });

  it("needs products.create to create and products.edit to update or reprice", async () => {
    const editOnly = createApp([PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.CATEGORIES_CREATE]);
    expect((await editOnly.post("/products", { mode: "create", items: [product()] })).status).toBe(403);
    expect((await editOnly.post("/products", { mode: "upsert", items: [product()] })).status).toBe(403);
    expect((await editOnly.post("/products", { mode: "price", items: [product()] })).status).toBe(200);

    const createOnly = createApp([PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.CATEGORIES_CREATE]);
    expect((await createOnly.post("/products", { mode: "create", items: [product()] })).body.data.results[0].status).toBe("created");
    expect((await createOnly.post("/products", { mode: "price", items: [product()] })).status).toBe(403);
  });

  /** The export's "Cost per item" cells: a whole-string search would match ids and timestamps. */
  function costCells(csv: string): string[] {
    const rows = csv.trim().split(/\r?\n/).map((line) =>
      [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].map((match) => (match[1] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"')));
    const column = (rows[0] ?? []).indexOf("Cost per item");
    return rows.slice(1).map((row) => row[column] ?? "");
  }

  it("writes and exports costs per item only for staff with View product costs", async () => {
    const costed = product({ variants: [{ ...product().variants[0], cost: 210 }] });
    const noCosts = createApp(ALL.filter((permission) => permission !== PERMISSIONS.PRODUCTS_VIEW_COSTS));
    expect((await noCosts.post("/products", { mode: "upsert", items: [costed] })).status).toBe(403);
    // The same file without costs imports.
    expect((await noCosts.post("/products", { mode: "upsert", items: [product()] })).status).toBe(200);
    noCosts.sqlite.exec("UPDATE product_variants SET cost_minor = 21000");
    const hidden = new TextDecoder().decode(new Uint8Array(await (await noCosts.app.request("/api/v1/admin/export/products?limit=10")).arrayBuffer()));
    expect(hidden).toContain("Cost per item");
    expect(costCells(hidden)).toEqual([""]);

    const withCosts = createApp();
    expect((await withCosts.post("/products", { mode: "upsert", items: [costed] })).status).toBe(200);
    const shown = new TextDecoder().decode(new Uint8Array(await (await withCosts.app.request("/api/v1/admin/export/products?limit=10")).arrayBuffer()));
    expect(costCells(shown)).toEqual(["210"]);
  });

  it("refuses to create categories and brands without categories.create", async () => {
    const { post } = createApp([PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_EDIT]);
    const response = await post("/products", { mode: "create", items: [product()] });
    expect(response.status).toBe(200);
    expect(response.body.data.results[0]).toMatchObject({ status: "failed", issues: [{ code: "forbidden" }] });
    const noReferences = await post("/products", { mode: "create", items: [product({ brand: null, categoryPath: [] })] });
    expect(noReferences.body.data.results[0].status).toBe("created");
  });

  it("needs customers.create and customers.edit for an upsert of customers", async () => {
    const customer = { ref: "rina", phone: "+8801712345678", name: "Rina", email: null, address: null };
    const createOnly = createApp([PERMISSIONS.CUSTOMERS_CREATE]);
    expect((await createOnly.post("/customers", { mode: "create", items: [customer] })).body.data.results[0].status).toBe("created");
    expect((await createOnly.post("/customers", { mode: "upsert", items: [customer] })).status).toBe(403);
  });

  it("validates items with the shared schema and refuses oversized requests", async () => {
    const { post } = createApp();
    const invalid = await post("/products", { mode: "create", items: [product({ title: "X" })] });
    expect(invalid.status).toBe(400);
    const tooMany = await post("/products", { mode: "create", items: Array.from({ length: 51 }, (_, index) => product({ ref: `p${index}`, handle: `product-${index}` })) });
    expect(tooMany.status).toBe(400);
    const big = JSON.stringify({ mode: "create", items: Array.from({ length: 12 }, (_, index) => product({ ref: `p${index}`, handle: `product-${index}`, descriptionHtml: "x".repeat(99_000) })) });
    const oversized = await post("/products", JSON.parse(big), { "Content-Length": String(new TextEncoder().encode(big).byteLength) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    const badPhone = await post("/customers", { mode: "create", items: [{ ref: "x", phone: "01712345678", name: "X", email: null, address: null }] });
    expect(badPhone.status).toBe(400);
  });

  it("sets inventory counts by SKU with a run id and reports a SKU it can't find", async () => {
    const { post } = createApp();
    await post("/products", { mode: "create", items: [product()] });
    const response = await post("/inventory", {
      runId: "run_route_test",
      items: [{ ref: "MUG-350", sku: "MUG-350", onHand: 30 }, { ref: "NOPE", sku: "NOPE-1", onHand: 1 }],
    });
    expect(response.body.data.results.map((result: { status: string }) => result.status)).toEqual(["updated", "failed"]);
    expect(response.body.data.results[0]).toMatchObject({ previousOnHand: 12, onHand: 30, location: { id: "loc_default" } });
  });
});
