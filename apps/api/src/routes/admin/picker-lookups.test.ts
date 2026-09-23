import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../utils/api-response";
import { adminProductsRoutes } from "./products";
import { adminCollectionRoutes } from "./collections";

function createTestApp() {
    let maxBoundParameters = 0;
    const { sqlite, db } = createSqliteD1Database({
        onQuery: (_query, values) => {
            maxBoundParameters = Math.max(maxBoundParameters, values.length);
        },
    });
    const product = sqlite.prepare("INSERT INTO products (id, name, price, slug) VALUES (?, ?, ?, ?)");
    product.run("prod_a", "Alpha", 10, "alpha");
    product.run("prod_b", "Beta", 20, "beta");
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db);
        await next();
    });
    app.route("/admin/products", adminProductsRoutes);
    app.route("/admin/collections", adminCollectionRoutes);
    return { app, maxBoundParameters: () => maxBoundParameters };
}

describe("admin picker lookup routes", () => {
    it("resolves product picker summaries by normalized ID list", async () => {
        const { app } = createTestApp();

        const response = await app.request("/api/v1/admin/products/by-ids?ids=prod_b,prod_a,,prod_b,prod_missing");
        const body = await response.json() as { success: boolean; data: { products: Array<{ id: string; name: string }> } };

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.products.map((entry) => entry.id).sort()).toEqual(["prod_a", "prod_b"]);
    });

    it("resolves collection picker summaries before the ID route can match", async () => {
        const response = await createTestApp().app.request("/api/v1/admin/collections/by-ids?ids=col_1,col_2,col_1");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true, data: { collections: [] } });
    });

    it("keeps multi-category product search within the D1 bound-parameter limit", async () => {
        const { app, maxBoundParameters } = createTestApp();
        const categoryIds = Array.from({ length: 150 }, (_, index) => `cat_${index}`).join(",");
        const selectedProductIds = Array.from({ length: 150 }, (_, index) => `prod_${index}`).join(",");

        const response = await app.request(
            `/api/v1/admin/collections/product-options?page=1&limit=10&search=a&categoryIds=${categoryIds}&selectedProductIds=${selectedProductIds}`,
        );

        expect(response.status).toBe(200);
        expect(maxBoundParameters()).toBeGreaterThan(0);
        expect(maxBoundParameters()).toBeLessThanOrEqual(100);
    });
});
