import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { adminProductsRoutes } from "./products";

type OperationDoc = {
    responses?: Record<string, unknown>;
};

type TestOpenApiDocument = {
    paths?: Record<string, Record<string, OperationDoc>>;
};

function buildAdminProductsSpec(): TestOpenApiDocument {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.route("/products", adminProductsRoutes);
    return app.getOpenAPIDocument({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
    }) as unknown as TestOpenApiDocument;
}

function expectResponses(
    spec: TestOpenApiDocument,
    path: string,
    method: string,
    statuses: string[],
): void {
    const operation = spec.paths?.[path]?.[method];
    if (!operation) {
        throw new Error(`Missing OpenAPI operation ${method.toUpperCase()} ${path}`);
    }
    for (const status of statuses) {
        expect(operation.responses, `${method.toUpperCase()} ${path} should document ${status}`).toHaveProperty(status);
    }
}

describe("admin product mutation OpenAPI responses", () => {
    it("documents representative product and variant mutation failures", () => {
        const spec = buildAdminProductsSpec();

        expectResponses(spec, "/api/v1/admin/products/bulk-delete", "post", [
            "204",
            "400",
            "401",
            "403",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/products/{id}/permanent", "delete", [
            "204",
            "401",
            "403",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/products/{id}/variants/{variantId}", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/products/{id}/variants/bulk-update", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
    });
});
