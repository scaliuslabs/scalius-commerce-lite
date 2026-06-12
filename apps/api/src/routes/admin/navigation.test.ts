import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";

const mocks = vi.hoisted(() => ({
    getNavigationItems: vi.fn(),
    getNavigationMenus: vi.fn(),
    getNavigationPreviewProductCount: vi.fn(),
    saveNavigationConfig: vi.fn(),
    updateNavigationConfig: vi.fn(),
    deleteNavigationConfig: vi.fn(),
}));

vi.mock("@scalius/core/modules/navigation", () => ({
    getNavigationItems: mocks.getNavigationItems,
    getNavigationMenus: mocks.getNavigationMenus,
    getNavigationPreviewProductCount: mocks.getNavigationPreviewProductCount,
    saveNavigationConfig: mocks.saveNavigationConfig,
    updateNavigationConfig: mocks.updateNavigationConfig,
    deleteNavigationConfig: mocks.deleteNavigationConfig,
}));

import { adminNavigationRoutes } from "./navigation";

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
    app.route("/admin/navigation", adminNavigationRoutes);
    return { app, db };
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
});
