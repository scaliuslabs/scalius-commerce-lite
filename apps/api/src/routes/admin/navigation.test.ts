import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";

const mocks = vi.hoisted(() => ({
    getNavigationItems: vi.fn(),
    getNavigationPreviewProductCount: vi.fn(),
    createNavigationMenu: vi.fn(),
    createNavigationMenuItem: vi.fn(),
    deleteNavigationMenuItem: vi.fn(),
    getNavigationAuthorityShadowReport: vi.fn(),
    getNavigationMenuAuthority: vi.fn(),
    getNavigationMenuItemAuthority: vi.fn(),
    getNavigationPlacementManifest: vi.fn(),
    listNavigationMenuItems: vi.fn(),
    listNavigationMenuPublications: vi.fn(),
    listNavigationMenus: vi.fn(),
    listNavigationPlacements: vi.fn(),
    moveNavigationMenuItem: vi.fn(),
    publishNavigationMenu: vi.fn(),
    rollbackNavigationMenu: vi.fn(),
    saveNavigationPlacement: vi.fn(),
    searchNavigationMenuItems: vi.fn(),
    updateNavigationMenuItem: vi.fn(),
    updateNavigationMenuMetadata: vi.fn(),
    getKv: vi.fn(),
    invalidateSiteSettingsCache: vi.fn(),
    invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/modules/navigation", () => ({
    getNavigationItems: mocks.getNavigationItems,
    getNavigationPreviewProductCount: mocks.getNavigationPreviewProductCount,
    createNavigationMenu: mocks.createNavigationMenu,
    createNavigationMenuItem: mocks.createNavigationMenuItem,
    deleteNavigationMenuItem: mocks.deleteNavigationMenuItem,
    getNavigationAuthorityShadowReport: mocks.getNavigationAuthorityShadowReport,
    getNavigationMenuAuthority: mocks.getNavigationMenuAuthority,
    getNavigationMenuItemAuthority: mocks.getNavigationMenuItemAuthority,
    getNavigationPlacementManifest: mocks.getNavigationPlacementManifest,
    listNavigationMenuItems: mocks.listNavigationMenuItems,
    listNavigationMenuPublications: mocks.listNavigationMenuPublications,
    listNavigationMenus: mocks.listNavigationMenus,
    listNavigationPlacements: mocks.listNavigationPlacements,
    moveNavigationMenuItem: mocks.moveNavigationMenuItem,
    publishNavigationMenu: mocks.publishNavigationMenu,
    rollbackNavigationMenu: mocks.rollbackNavigationMenu,
    saveNavigationPlacement: mocks.saveNavigationPlacement,
    searchNavigationMenuItems: mocks.searchNavigationMenuItems,
    updateNavigationMenuItem: mocks.updateNavigationMenuItem,
    updateNavigationMenuMetadata: mocks.updateNavigationMenuMetadata,
}));

vi.mock("@scalius/core/modules/settings", () => ({
    invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
}));

vi.mock("../../utils/kv-cache", () => ({
    getKv: mocks.getKv,
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
    mocks.getKv.mockReturnValue({ id: "kv" });
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
