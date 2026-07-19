import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  buildDefaultNavigation: vi.fn(),
  getNavigationMenu: vi.fn(),
  getNavigationMenus: vi.fn(),
  getNavigationPlacementManifest: vi.fn(),
  getPublishedNavigationMenuTree: vi.fn(),
  listPublishedNavigationMenuItems: vi.fn(),
}));

vi.mock("@scalius/core/modules/navigation", () => ({
  buildDefaultNavigation: mocks.buildDefaultNavigation,
  getNavigationMenu: mocks.getNavigationMenu,
  getNavigationMenus: mocks.getNavigationMenus,
  getNavigationPlacementManifest: mocks.getNavigationPlacementManifest,
  getPublishedNavigationMenuTree: mocks.getPublishedNavigationMenuTree,
  listPublishedNavigationMenuItems: mocks.listPublishedNavigationMenuItems,
}));

vi.mock("../middleware/cache", () => ({
  cacheMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
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
