import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  createBrand: vi.fn(),
  updateBrand: vi.fn(),
  updateBrandStatus: vi.fn(),
  trashBrands: vi.fn(),
  restoreBrands: vi.fn(),
  permanentlyDeleteBrands: vi.fn(),
  getBrandById: vi.fn(),
  getBrandsByIds: vi.fn(),
  moveCategory: vi.fn(),

}));

vi.mock("@scalius/core/modules/brands", async () => {
  const actual = await vi.importActual<typeof import("@scalius/core/modules/brands")>("@scalius/core/modules/brands");
  return {
    ...actual,
    createBrand: mocks.createBrand,
    updateBrand: mocks.updateBrand,
    updateBrandStatus: mocks.updateBrandStatus,
    trashBrands: mocks.trashBrands,
    restoreBrands: mocks.restoreBrands,
    permanentlyDeleteBrands: mocks.permanentlyDeleteBrands,
    getBrandById: mocks.getBrandById,
    getBrandsByIds: mocks.getBrandsByIds,
  };
});

vi.mock("@scalius/core/modules/categories", async () => {
  const actual = await vi.importActual<typeof import("@scalius/core/modules/categories")>("@scalius/core/modules/categories");
  return { ...actual, moveCategory: mocks.moveCategory };
});

import { adminBrandRoutes } from "./brands";
import { adminCategoryRoutes } from "./categories";

/** The brand every write answers (`{ brand }`, as brands.get reads it). */
const BRAND = {
  id: "brd_walton01", name: "Walton", slug: "walton", status: "published", sortOrder: 0, revision: 2,
  noIndex: false, excludeFromSitemap: false, productCount: 0, logo: null,
  createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z", deletedAt: null,
  description: null, metaTitle: null, metaDescription: null, canonicalPath: null, listingTemplate: null, logoMediaId: null,
};

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const env = {} as unknown as Env;
  mocks.createBrand.mockResolvedValue({ id: "brd_walton01", slug: "walton", revision: 1, status: "draft" });
  mocks.updateBrand.mockResolvedValue({ revision: 2, status: "published" });
  mocks.updateBrandStatus.mockResolvedValue({ revision: 2, status: "published" });
  mocks.trashBrands.mockResolvedValue(undefined);
  mocks.restoreBrands.mockResolvedValue(undefined);
  mocks.permanentlyDeleteBrands.mockResolvedValue(undefined);
  mocks.getBrandById.mockResolvedValue(BRAND);
  mocks.getBrandsByIds.mockResolvedValue([BRAND]);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/admin/brands", adminBrandRoutes);
  app.route("/admin/categories", adminCategoryRoutes);
  return { app, env };
}

async function send(app: OpenAPIHono<{ Bindings: Env }>, env: Env, path: string, method: string, body: unknown) {
  return app.request(`/api/v1/admin${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env);
}

const claims = { brands: [{ id: "brd_walton01", expectedRevision: 1 }] };

describe("admin brand and category tree writes", () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ["/brands", "POST", { name: "Walton" }, 201],
    ["/brands/brd_walton01", "PUT", { name: "Walton", slug: "walton", status: "published", expectedRevision: 1 }, 200],
    ["/brands/brd_walton01/status", "PATCH", { status: "published", expectedRevision: 1 }, 200],
    ["/brands/trash", "POST", claims, 200],
    ["/brands/restore", "POST", claims, 200],
    ["/brands/delete-permanently", "POST", claims, 200],
  ])("%s %s commits", async (path, method, body, status) => {
    const { app, env } = createTestApp();
    const response = await send(app, env, path, method, body);

    expect(response.status, await response.clone().text()).toBe(status);
    const data = (await response.json() as { data: Record<string, unknown> }).data;
    if (path.endsWith("/trash") || path.endsWith("/restore")) expect(data).toEqual({ brands: [BRAND] });
    else if (path.endsWith("/delete-permanently")) expect(data).toEqual({ count: 1 });
    else expect(data).toEqual({ brand: BRAND });
  });

  it("reports a refused brand write", async () => {
    const { app, env } = createTestApp();
    mocks.updateBrand.mockRejectedValueOnce(new Error("refused"));

    const response = await send(app, env, "/brands/brd_walton01", "PUT", {
      name: "Walton", slug: "walton", status: "published", expectedRevision: 1,
    });

    expect(response.status).toBe(500);

  });

  it("returns changed and unchanged category move results", async () => {
    const { app, env } = createTestApp();
    mocks.moveCategory.mockResolvedValueOnce({ revision: 2, parentId: "cat_root", changed: true });
    const moved = await send(app, env, "/categories/cat_child/parent", "PATCH", { expectedRevision: 1, parentId: "cat_root" });
    expect(moved.status).toBe(200);

    mocks.moveCategory.mockResolvedValueOnce({ revision: 2, parentId: "cat_root", changed: false });
    const unchanged = await send(app, env, "/categories/cat_child/parent", "PATCH", { expectedRevision: 2, parentId: "cat_root" });
    expect(unchanged.status).toBe(200);

  });
});
