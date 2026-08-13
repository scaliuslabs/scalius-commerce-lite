import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { adminProductsRoutes } from "./products";

type OperationDoc = {
    operationId?: string;
    responses?: Record<string, unknown>;
    requestBody?: unknown;
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
            "200",
            "400",
            "401",
            "403",
            "409",
        ]);
        const bulkDelete = JSON.stringify(
            spec.paths?.["/api/v1/admin/products/bulk-delete"]?.post,
        );
        expect(bulkDelete).toContain('"outcomes"');
        expect(bulkDelete).toContain('"blocked"');
        expect(bulkDelete).toContain('"failed"');
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
        expectResponses(spec, "/api/v1/admin/products/{id}/options/matrix", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
    });

    it("documents the ordered mixed-media cutover and SKU removal acknowledgement", () => {
        const spec = buildAdminProductsSpec();
        const create = JSON.stringify(spec.paths?.["/api/v1/admin/products"]?.post);
        const detail = JSON.stringify(spec.paths?.["/api/v1/admin/products/{id}"]?.get);
        const update = JSON.stringify(spec.paths?.["/api/v1/admin/products/{id}"]?.put);

        expect(create).toContain('"media"');
        expect(create).toContain('"mediaId"');
        expect(create).not.toContain('"images"');
        expect(detail).toContain('"media"');
        expect(detail).toContain('"posterUrl"');
        expect(detail).not.toContain('"images"');
        expect(update).toContain('"acknowledgedSkuImageRemovalIds"');
        expect(update).toContain("PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT");
        expect(update).toContain('"affectedSkus"');
    });

    it("uses mediaCount rather than the removed imageCount list field", () => {
        const spec = buildAdminProductsSpec();
        const list = JSON.stringify(spec.paths?.["/api/v1/admin/products"]?.get);
        expect(list).toContain('"mediaCount"');
        expect(list).not.toContain('"imageCount"');
    });

    it("documents bounded semantic reads and revision-guarded range writes", () => {
        const spec = buildAdminProductsSpec();
        const path = spec.paths?.["/api/v1/admin/products/{id}/sections/{section}"];
        const read = JSON.stringify(path?.get);
        const write = JSON.stringify(path?.patch);

        expect(path?.get?.operationId).toBe("dashboard.products.get_section");
        expect(path?.patch?.operationId).toBe("dashboard.products.update_section");
        expect(read).toContain('"nextOffset"');
        expect(read).toContain('"maxLength":12000');
        expect(read).toContain('"maxItems":10');
        expect(read).toContain('"additional_info_text"');
        expect(write).toContain('"expectedAggregateRevision"');
        expect(write).toContain('"deleteCount"');
        expect(write).toContain('"maxLength":12000');
        expect(write).toContain('"409"');
        expect(write).toContain("PRODUCT_REVISION_CONFLICT");
    });
});
