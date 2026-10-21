import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { inlineComponentSchemaRefs } from "@scalius/shared/openapi-schema-refs";
import { adminProductsRoutes } from "./products";

type OpenApiDocument = {
    paths?: Record<string, Record<string, unknown>>;
};

function buildSpec(): OpenApiDocument {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.route("/products", adminProductsRoutes);
    const document = app.getOpenAPIDocument({
        openapi: "3.0.0",
        info: { title: "Products", version: "test" },
    }) as unknown as OpenApiDocument & { components?: { schemas?: Record<string, unknown> } };
    // Shared shapes (the error envelope, the product conflict) are components: read them inline.
    return { paths: inlineComponentSchemaRefs(document.paths, document.components?.schemas ?? {}) as OpenApiDocument["paths"] };
}

function operationJson(
    spec: OpenApiDocument,
    path: string,
    method: string,
): string {
    const operation = spec.paths?.[path]?.[method];
    if (!operation) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
    return JSON.stringify(operation);
}

describe("admin product aggregate revision OpenAPI contract", () => {
    it("requires expected revisions and returns aggregate revisions", () => {
        const spec = buildSpec();
        const mutations = [
            ["/api/v1/admin/products/{id}", "put"],
            ["/api/v1/admin/products/{id}/variants", "post"],
            ["/api/v1/admin/products/{id}/variants/{variantId}", "put"],
            ["/api/v1/admin/products/{id}/options/matrix", "put"],
        ] as const;

        for (const [path, method] of mutations) {
            const json = operationJson(spec, path, method);
            expect(json, `${method.toUpperCase()} ${path}`).toContain(
                "expectedAggregateRevision",
            );
            expect(json, `${method.toUpperCase()} ${path}`).toContain(
                "aggregateRevision",
            );
            expect(json, `${method.toUpperCase()} ${path}`).toContain('"409"');
            expect(json, `${method.toUpperCase()} ${path}`).toContain(
                "product_revision_conflict",
            );
        }
    });

    it("takes expectedRevision on the stable product writes and answers the product", () => {
        const spec = buildSpec();
        const stable = [
            ["/api/v1/admin/products/{id}", "delete"],
            ["/api/v1/admin/products/{id}/restore", "post"],
            ["/api/v1/admin/products/{id}/variants/{variantId}", "delete"],
        ] as const;
        for (const [path, method] of stable) {
            const json = operationJson(spec, path, method);
            expect(json, `${method.toUpperCase()} ${path}`).toContain('"expectedRevision"');
            expect(json, `${method.toUpperCase()} ${path}`).not.toContain('"expectedAggregateRevision"');
            expect(json, `${method.toUpperCase()} ${path}`).toContain('"product"');
            expect(json, `${method.toUpperCase()} ${path}`).toContain("product_revision_conflict");
        }
    });

    it("does not advertise persisted variant duplication", () => {
        const spec = buildSpec();
        expect(
            spec.paths?.["/api/v1/admin/products/{id}/variants/{variantId}/duplicate"],
        ).toBeUndefined();
    });

    it("projects aggregate revisions in product and trash list rows", () => {
        const spec = buildSpec();
        const list = operationJson(spec, "/api/v1/admin/products", "get");
        expect(list).toContain("aggregateRevision");
    });
});
