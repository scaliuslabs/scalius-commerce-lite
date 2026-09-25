import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  buildDefaultNavigation: vi.fn(),
  getNavigationPlacementManifest: vi.fn(),
  getPublishedNavigationMenuTree: vi.fn(),
  listPublishedNavigationMenuItems: vi.fn(),
  readCategoryNavigation: vi.fn(),
}));

vi.mock("@scalius/core/modules/navigation", () => ({
  buildDefaultNavigation: mocks.buildDefaultNavigation,
  getNavigationPlacementManifest: mocks.getNavigationPlacementManifest,
  getPublishedNavigationMenuTree: mocks.getPublishedNavigationMenuTree,
  listPublishedNavigationMenuItems: mocks.listPublishedNavigationMenuItems,
  readCategoryNavigation: mocks.readCategoryNavigation,
  CATEGORY_NAVIGATION_NODE_LIMIT: 1000,
}));

import { navigationRoutes } from "./navigation";

function createTestApp() {
  const db = { id: "db" };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/navigation", navigationRoutes);
  return { app, db };
}

describe("public normalized navigation routes", () => {
  afterEach(() => vi.clearAllMocks());

  it("serves the reachable category tree for the /categories index", async () => {
    const tree = { nodes: [{ id: "c1", name: "Laptop", slug: "laptop", parentId: null, canonicalPath: null, imageUrl: null }], truncated: false };
    mocks.readCategoryNavigation.mockResolvedValue(tree);
    const { app, db } = createTestApp();
    const response = await app.request("/api/v1/navigation/categories");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: tree });
    expect(mocks.readCategoryNavigation).toHaveBeenCalledWith(db);
  });

  it("returns a no-store placement manifest with menu and dependency generations", async () => {
    mocks.getNavigationPlacementManifest.mockResolvedValue([{
      id: "placement_header_primary",
      surface: "header",
      slot: "primary",
      menuId: "menu_1",
      publishedRevision: 4,
      dependencyRevision: 2,
    }]);
    const { app, db } = createTestApp();

    const response = await app.request("/api/v1/navigation/placements");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getNavigationPlacementManifest).toHaveBeenCalledWith(db);
  });

  it("serves a bounded tree only for the requested current revision", async () => {
    mocks.getPublishedNavigationMenuTree.mockResolvedValue({
      id: "menu_1",
      name: "Primary",
      handle: "primary",
      publishedRevision: 4,
      dependencyRevision: 2,
      checksum: "a".repeat(64),
      items: [{ id: "item_1", title: "Shop", href: "/search" }],
    });
    const { app, db } = createTestApp();

    const current = await app.request(
      "/api/v1/navigation/menus/menu_1?revision=4&dependencyRevision=2",
    );
    const stale = await app.request(
      "/api/v1/navigation/menus/menu_1?revision=3&dependencyRevision=2",
    );

    expect(current.status).toBe(200);
    expect(stale.status).toBe(404);
    expect(mocks.getPublishedNavigationMenuTree).toHaveBeenCalledWith(
      db,
      "menu_1",
      { maxItems: 150 },
    );
  });

  it("encodes the next parent-page cursor without exposing database syntax", async () => {
    mocks.listPublishedNavigationMenuItems.mockResolvedValue({
      menu: {
        id: "menu_1",
        name: "Primary",
        handle: "primary",
        publishedRevision: 4,
        dependencyRevision: 2,
      },
      parentId: null,
      items: [{
        id: "item_1",
        title: "Shop",
        href: "/search",
        position: 1024,
        childCount: 2,
      }],
      nextCursor: { position: 1024, id: "item_1" },
    });
    const { app } = createTestApp();

    const response = await app.request(
      "/api/v1/navigation/menus/menu_1/items?revision=4&dependencyRevision=2&limit=1",
    );
    const body = await response.json() as { data?: { nextCursor?: string } };

    expect(response.status).toBe(200);
    expect(body.data?.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(atob(body.data!.nextCursor!.replaceAll("-", "+").replaceAll("_", "/"))))
      .toEqual({ position: 1024, id: "item_1" });
  });
});
