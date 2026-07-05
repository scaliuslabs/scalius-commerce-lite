import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { adminOrdersRoutes } from "./orders";

type OperationDoc = {
    responses?: Record<string, unknown>;
};

type TestOpenApiDocument = {
    paths?: Record<string, Record<string, OperationDoc>>;
};

function buildAdminOrdersSpec(): TestOpenApiDocument {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.route("/orders", adminOrdersRoutes);
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

describe("admin order mutation OpenAPI responses", () => {
    it("documents representative order, refund, return, COD, and fulfillment failures", () => {
        const spec = buildAdminOrdersSpec();

        expectResponses(spec, "/api/v1/admin/orders/{id}", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/bulk-delete", "post", [
            "204",
            "400",
            "401",
            "403",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/status", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/cod", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/fulfill", "post", [
            "201",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/return", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
            "503",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/refund", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
            "503",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/shipments/{shipmentId}/refresh", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
            "503",
        ]);
    });
});
