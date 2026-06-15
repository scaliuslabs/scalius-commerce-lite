import { OpenAPIHono, z } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    getProductsByIds: vi.fn(),
    getProductDetails: vi.fn(),
    getCollectionCategoryOptions: vi.fn(),
    getCollectionsByIds: vi.fn(),
    getCollectionById: vi.fn(),
}));

vi.mock("@scalius/core/modules/products/products.admin", () => ({
    getProductStats: vi.fn(),
    listProducts: vi.fn(),
    createProduct: vi.fn(),
    bulkDeleteProducts: vi.fn(),
    getProductDetails: mocks.getProductDetails,
    getProductsByIds: mocks.getProductsByIds,
    updateProduct: vi.fn(),
    deleteProduct: vi.fn(),
    restoreProduct: vi.fn(),
    permanentlyDeleteProduct: vi.fn(),
    bulkUpdateVariants: vi.fn(),
}));

vi.mock("@scalius/core/modules/collections", () => ({
    listCollections: vi.fn(),
    getCollectionById: mocks.getCollectionById,
    getCollectionCategoryOptions: mocks.getCollectionCategoryOptions,
    getCollectionsByIds: mocks.getCollectionsByIds,
    createCollection: vi.fn(),
    updateCollection: vi.fn(),
    deleteCollection: vi.fn(),
    bulkDeleteCollections: vi.fn(),
    bulkActivateCollections: vi.fn(),
    bulkDeactivateCollections: vi.fn(),
    restoreCollections: vi.fn(),
    reorderCollections: vi.fn(),
    createCollectionSchema: z.object({}).passthrough(),
    updateCollectionSchema: z.object({}).passthrough(),
}));

import { adminProductsRoutes } from "./products";
import { adminCollectionRoutes } from "./collections";

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
    app.route("/admin/products", adminProductsRoutes);
    app.route("/admin/collections", adminCollectionRoutes);
    return { app, db };
}

describe("admin picker lookup routes", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("resolves product picker summaries by normalized ID list", async () => {
        mocks.getProductsByIds.mockResolvedValue([
            {
                id: "prod_b",
                name: "Beta",
                price: 20,
                categoryId: "cat_1",
                primaryImage: null,
                discountPercentage: null,
            },
        ]);
        const { app, db } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/products/by-ids?ids=prod_b,prod_a,,prod_b",
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: {
                products: [
                    {
                        id: "prod_b",
                        name: "Beta",
                        price: 20,
                        categoryId: "cat_1",
                        primaryImage: null,
                        discountPercentage: null,
                    },
                ],
            },
        });
        expect(mocks.getProductsByIds).toHaveBeenCalledWith(db, ["prod_b", "prod_a"]);
        expect(mocks.getProductDetails).not.toHaveBeenCalled();
    });

    it("returns lightweight collection category options", async () => {
        mocks.getCollectionCategoryOptions.mockResolvedValue([
            { id: "cat_1", name: "Shirts" },
        ]);
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/collections/category-options");
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: { categories: [{ id: "cat_1", name: "Shirts" }] },
        });
        expect(mocks.getCollectionCategoryOptions).toHaveBeenCalledWith(db);
    });

    it("resolves collection picker summaries before the ID route can match", async () => {
        mocks.getCollectionsByIds.mockResolvedValue([
            { id: "col_1", name: "Featured", type: "manual" },
        ]);
        const { app, db } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/collections/by-ids?ids=col_1,col_2,col_1",
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: {
                collections: [{ id: "col_1", name: "Featured", type: "manual" }],
            },
        });
        expect(mocks.getCollectionsByIds).toHaveBeenCalledWith(db, ["col_1", "col_2"]);
        expect(mocks.getCollectionById).not.toHaveBeenCalled();
    });
});
