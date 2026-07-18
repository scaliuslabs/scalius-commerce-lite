import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";

const mocks = vi.hoisted(() => ({
    getNavigationItems: vi.fn(),
    getNavigationPreviewProductCount: vi.fn(),
    getGeneralSettings: vi.fn(),
    saveHeaderConfig: vi.fn(),
    saveFooterConfig: vi.fn(),
    getKv: vi.fn(),
    invalidateSiteSettingsCache: vi.fn(),
    invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/modules/navigation", () => ({
    getNavigationItems: mocks.getNavigationItems,
    getNavigationPreviewProductCount: mocks.getNavigationPreviewProductCount,
}));

vi.mock("@scalius/core/modules/settings/site-settings.service", () => ({
    getGeneralSettings: mocks.getGeneralSettings,
    saveHeaderConfig: mocks.saveHeaderConfig,
    saveFooterConfig: mocks.saveFooterConfig,
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
    mocks.saveHeaderConfig.mockResolvedValue({ revision: 2 });
    mocks.saveFooterConfig.mockResolvedValue({ revision: 2 });
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

    it.each([
        {
            method: "POST" as const,
            path: "/api/v1/admin/navigation",
            body: { type: "header", config: { items: [] }, expectedRevision: 1 },
        },
        {
            method: "PUT" as const,
            path: "/api/v1/admin/navigation/site_settings_id",
            body: { type: "footer", config: { items: [] }, expectedRevision: 1 },
        },
        {
            method: "DELETE" as const,
            path: "/api/v1/admin/navigation/site_settings_id",
            body: { type: "header", expectedRevision: 1 },
        },
    ])("invalidates layout caches after $method navigation writes", async ({ method, path, body }) => {
        const { app, env } = createTestApp();

        const response = await app.request(
            path,
            {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["layout"],
            expect.objectContaining({ env }),
        );
    });

    it("rejects compatibility writes that omit the revision claim", async () => {
        const { app } = createTestApp();

        const response = await app.request("/api/v1/admin/navigation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "header", config: { navigation: [] } }),
        });

        expect(response.status).toBe(400);
        expect(mocks.saveHeaderConfig).not.toHaveBeenCalled();
    });
});
