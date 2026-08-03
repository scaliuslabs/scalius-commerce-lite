import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";

const mocks = vi.hoisted(() => ({
    getNavigationItems: vi.fn(),
    getNavigationPreviewProductCount: vi.fn(),
    listNavigationResources: vi.fn(),
    createNavigationMenu: vi.fn(),
    createNavigationMenuItem: vi.fn(),
    deleteNavigationMenuItem: vi.fn(),
    getNavigationAuthorityShadowReport: vi.fn(),
    getNavigationMenuAuthority: vi.fn(),
    getNavigationMenuItemAuthority: vi.fn(),
    getNavigationMenuMoveOptions: vi.fn(),
    getNavigationPlacementManifest: vi.fn(),
    listNavigationMenuItems: vi.fn(),
    listNavigationMenuPublications: vi.fn(),
    listNavigationMenus: vi.fn(),
    listNavigationPlacements: vi.fn(),
    moveNavigationMenuItem: vi.fn(),
    publishNavigationMenu: vi.fn(),
    restoreNavigationMenu: vi.fn(),
    rollbackNavigationMenu: vi.fn(),
    saveNavigationPlacement: vi.fn(),
    searchNavigationMenuItems: vi.fn(),
    trashNavigationMenu: vi.fn(),
    updateNavigationMenuItem: vi.fn(),
    updateNavigationMenuMetadata: vi.fn(),
    invalidateSiteSettingsCache: vi.fn(),
    invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/modules/navigation", () => ({
    getNavigationItems: mocks.getNavigationItems,
    getNavigationPreviewProductCount: mocks.getNavigationPreviewProductCount,
    listNavigationResources: mocks.listNavigationResources,
    createNavigationMenu: mocks.createNavigationMenu,
    createNavigationMenuItem: mocks.createNavigationMenuItem,
    deleteNavigationMenuItem: mocks.deleteNavigationMenuItem,
    getNavigationAuthorityShadowReport: mocks.getNavigationAuthorityShadowReport,
    getNavigationMenuAuthority: mocks.getNavigationMenuAuthority,
    getNavigationMenuItemAuthority: mocks.getNavigationMenuItemAuthority,
    getNavigationMenuMoveOptions: mocks.getNavigationMenuMoveOptions,
    getNavigationPlacementManifest: mocks.getNavigationPlacementManifest,
    listNavigationMenuItems: mocks.listNavigationMenuItems,
    listNavigationMenuPublications: mocks.listNavigationMenuPublications,
    listNavigationMenus: mocks.listNavigationMenus,
    listNavigationPlacements: mocks.listNavigationPlacements,
    moveNavigationMenuItem: mocks.moveNavigationMenuItem,
    publishNavigationMenu: mocks.publishNavigationMenu,
    restoreNavigationMenu: mocks.restoreNavigationMenu,
    rollbackNavigationMenu: mocks.rollbackNavigationMenu,
    saveNavigationPlacement: mocks.saveNavigationPlacement,
    searchNavigationMenuItems: mocks.searchNavigationMenuItems,
    trashNavigationMenu: mocks.trashNavigationMenu,
    updateNavigationMenuItem: mocks.updateNavigationMenuItem,
    updateNavigationMenuMetadata: mocks.updateNavigationMenuMetadata,
}));

vi.mock("@scalius/core/modules/settings", () => ({
    invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
}));

vi.mock("../../utils/cache-invalidation", () => ({
    invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

import { adminNavigationRoutes } from "./navigation";

function createTestApp() {
    const db = { id: "db" };
    const env = {
        CACHE: { id: "api-cache-kv" },
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
    } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    mocks.invalidateSiteSettingsCache.mockResolvedValue(undefined);
    mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/admin/navigation", adminNavigationRoutes);
    return { app, db, env };
}

describe("admin navigation routes", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("pages and hydrates typed navigation resources without a whole-catalog read", async () => {
        mocks.listNavigationResources.mockResolvedValue({
            items: [{
                id: "prod_101",
                name: "Product 101",
                type: "product",
                url: "/products/product-101",
                available: true,
            }],
            selected: {
                id: "prod_005",
                name: "Product 005",
                type: "product",
                url: "/products/product-005",
                available: false,
            },
            nextCursor: { name: "Product 101", id: "prod_101" },
        });
        const { app, db } = createTestApp();
        const cursor = btoa(JSON.stringify({ name: "Product 100", id: "prod_100" }))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/g, "");

        const response = await app.request(
            `/api/v1/admin/navigation/resources?type=product&q=Product&limit=20&selectedId=prod_005&cursor=${cursor}`,
        );
        const body = await response.json() as {
            success: boolean;
            data?: { items?: unknown[]; selected?: { available?: boolean }; nextCursor?: string | null };
        };

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data?.items).toHaveLength(1);
        expect(body.data?.selected?.available).toBe(false);
        expect(body.data?.nextCursor).toEqual(expect.any(String));
        expect(mocks.listNavigationResources).toHaveBeenCalledWith(db, {
            type: "product",
            query: "Product",
            cursor: { name: "Product 100", id: "prod_100" },
            limit: 20,
            selectedId: "prod_005",
        });
    });

    it("previews dynamic navigation products with category and attribute filters", async () => {
        mocks.getNavigationPreviewProductCount.mockResolvedValue({ count: 7 });
        const { app, db } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/preview-products?categoryId=cat_1&search=shirt&minPrice=10&freeDelivery=true&page=2&limit=50&sortBy=price&color=Blue&size=M&empty=",
        );
        const body = await response.json() as {
            success: boolean;
            data?: { count?: number };
        };

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, data: { count: 7 } });
        expect(mocks.getNavigationPreviewProductCount).toHaveBeenCalledWith(db, {
            categoryId: "cat_1",
            search: "shirt",
            minPrice: 10,
            maxPrice: undefined,
            freeDelivery: "true",
            hasDiscount: undefined,
            attributeFilters: [
                { slug: "color", value: "Blue" },
                { slug: "size", value: "M" },
            ],
        });
    });

    it("rejects preview requests without a category", async () => {
        const { app } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/preview-products?color=Blue",
        );

        expect(response.status).toBe(400);
        expect(mocks.getNavigationPreviewProductCount).not.toHaveBeenCalled();
    });

    it("returns not found when the preview category is not public", async () => {
        mocks.getNavigationPreviewProductCount.mockRejectedValue(
            new NotFoundError("Category not found"),
        );
        const { app } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/preview-products?categoryId=cat_deleted",
        );

        expect(response.status).toBe(404);
    });

    it("exposes a bounded migration parity report without mutating navigation", async () => {
        mocks.getNavigationAuthorityShadowReport.mockResolvedValue({
            ready: true,
            legacyMenuCount: 5,
            authorityMenuCount: 5,
            legacyItemCount: 20,
            authorityItemCount: 20,
            mismatches: [],
        });
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/navigation/authority-shadow");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            success: true,
            data: {
                ready: true,
                legacyMenuCount: 5,
                authorityMenuCount: 5,
                legacyItemCount: 20,
                authorityItemCount: 20,
                mismatches: [],
            },
        });
        expect(mocks.getNavigationAuthorityShadowReport).toHaveBeenCalledWith(db);
    });

    it("returns bounded exact-move context and preserves an explicit top-level choice", async () => {
        mocks.getNavigationMenuMoveOptions.mockResolvedValue({
            item: { id: "item_1", label: "Footwear", parentId: "parent_1" },
            subtreeDepth: 1,
            currentPosition: 2,
            selectedParentId: null,
            positionCount: 5,
            parents: [],
        });
        const { app, db } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/menus/menu_1/items/item_1/move-options?topLevel=true&q=foo&limit=25",
        );

        expect(response.status).toBe(200);
        expect(mocks.getNavigationMenuMoveOptions).toHaveBeenCalledWith(db, "menu_1", "item_1", {
            query: "foo",
            limit: 25,
            selectedParentId: null,
        });
    });

    it("moves to an exact zero-based sibling index", async () => {
        mocks.moveNavigationMenuItem.mockResolvedValue({ revision: 7 });
        const { app, db } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/menus/menu_1/items/item_1/move",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    expectedRevision: 6,
                    parentId: null,
                    index: 3,
                }),
            },
        );

        expect(response.status).toBe(200);
        expect(mocks.moveNavigationMenuItem).toHaveBeenCalledWith(db, "menu_1", "item_1", {
            expectedRevision: 6,
            parentId: null,
            index: 3,
        });
    });

    it("moves a menu to Trash and invalidates public layout", async () => {
        mocks.trashNavigationMenu.mockResolvedValue({
            revision: 8,
        });
        const { app, db, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/menus/menu_1",
            {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedRevision: 7 }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.trashNavigationMenu).toHaveBeenCalledWith(db, "menu_1", {
            expectedRevision: 7,
        });
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["layout"],
            expect.objectContaining({ env }),
        );
    });

    it("restores a menu without reassigning storefront placements", async () => {
        mocks.restoreNavigationMenu.mockResolvedValue({ revision: 9 });
        const { app, db, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/menus/menu_1/restore",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedRevision: 8 }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.restoreNavigationMenu).toHaveBeenCalledWith(db, "menu_1", {
            expectedRevision: 8,
        });
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["layout"],
            expect.objectContaining({ env }),
        );
    });

    it("publishes through the canonical command and invalidates public layout only then", async () => {
        mocks.publishNavigationMenu.mockResolvedValue({
            revision: 6,
            publishedRevision: 6,
            itemCount: 3,
            checksum: "a".repeat(64),
        });
        const { app, db, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/menus/menu_1/publish",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedRevision: 5 }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.publishNavigationMenu).toHaveBeenCalledWith(db, "menu_1", {
            expectedRevision: 5,
            publishedBy: null,
        });
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["layout"],
            expect.objectContaining({ env }),
        );
    });

    it("rolls a publication forward as a new revision and invalidates public layout", async () => {
        mocks.rollbackNavigationMenu.mockResolvedValue({
            revision: 9,
            publishedRevision: 9,
            sourceRevision: 5,
            itemCount: 3,
            checksum: "b".repeat(64),
        });
        const { app, db, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/menus/menu_1/rollback",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedRevision: 8, sourceRevision: 5 }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.rollbackNavigationMenu).toHaveBeenCalledWith(db, "menu_1", {
            expectedRevision: 8,
            sourceRevision: 5,
            publishedBy: null,
        });
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["layout"],
            expect.objectContaining({ env }),
        );
    });

    it("saves one registered placement through its independent revision boundary", async () => {
        mocks.saveNavigationPlacement.mockResolvedValue({
            placement: { id: "placement_header_primary", revision: 2 },
        });
        const { app, db, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/navigation/placements/placement_header_primary",
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    expectedRevision: 1,
                    surface: "header",
                    slot: "primary",
                    position: 0,
                    menuId: "menu_1",
                    isEnabled: true,
                }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.saveNavigationPlacement).toHaveBeenCalledWith(db, {
            id: "placement_header_primary",
            expectedRevision: 1,
            surface: "header",
            slot: "primary",
            position: 0,
            menuId: "menu_1",
            isEnabled: true,
        });
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledTimes(1);
    });

});
