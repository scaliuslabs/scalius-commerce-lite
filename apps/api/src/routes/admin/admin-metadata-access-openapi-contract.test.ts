import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { finalizeOpenApiContract, type OpenApiDocument } from "../../openapi-contract";
import { adminAttributesRoutes } from "./attributes";
import { adminMediaRoutes } from "./media";
import { adminNavigationRoutes } from "./navigation";
import { adminRbacRoutes } from "./rbac";

type TestOperation = {
    responses?: Record<string, unknown>;
};

function buildAdminMetadataAccessSpec(options: { finalize?: boolean } = {}): OpenApiDocument {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.route("/admin/attributes", adminAttributesRoutes);
    app.route("/admin/rbac", adminRbacRoutes);
    app.route("/admin/navigation", adminNavigationRoutes);
    app.route("/admin/media", adminMediaRoutes);

    const spec = app.getOpenAPIDocument({
        openapi: "3.0.0",
        info: { title: "Admin metadata/access response docs", version: "test" },
    }) as unknown as OpenApiDocument;

    return options.finalize === false ? spec : finalizeOpenApiContract(spec);
}

function operation(spec: OpenApiDocument, path: string, method: string): TestOperation {
    const pathItem = spec.paths?.[path] as Record<string, TestOperation> | undefined;
    const op = pathItem?.[method];
    if (!op) throw new Error(`Missing OpenAPI operation ${method.toUpperCase()} ${path}`);
    return op;
}

function expectResponses(
    spec: OpenApiDocument,
    path: string,
    method: string,
    statuses: string[],
): void {
    const responses = operation(spec, path, method).responses;
    for (const status of statuses) {
        expect(responses, `${method.toUpperCase()} ${path} should document ${status}`).toHaveProperty(status);
    }
}

describe("admin metadata/access OpenAPI error responses", () => {
    it("documents attribute conflict and not-found mutation statuses", () => {
        const spec = buildAdminMetadataAccessSpec();

        expectResponses(spec, "/api/v1/admin/attributes", "post", [
            "201",
            "400",
            "401",
            "403",
            "409",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/attributes/{id}", "delete", [
            "204",
            "401",
            "403",
            "409",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/attributes/bulk-delete", "post", [
            "204",
            "400",
            "401",
            "403",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/attributes/{id}/values", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
            "500",
        ]);
    });

    it("documents RBAC conflict and not-found paths", () => {
        const rawSpec = buildAdminMetadataAccessSpec({ finalize: false });
        const spec = buildAdminMetadataAccessSpec();

        expect(operation(rawSpec, "/api/v1/admin/rbac/roles", "post").responses).toHaveProperty("409");
        expectResponses(spec, "/api/v1/admin/rbac/roles", "post", [
            "201",
            "400",
            "401",
            "403",
            "409",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/rbac/roles/{id}", "delete", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/rbac/roles/{id}", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/rbac/user-roles", "delete", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "500",
        ]);
    });

    it("documents navigation not-found paths", () => {
        const spec = buildAdminMetadataAccessSpec();

        expectResponses(spec, "/api/v1/admin/navigation/preview-products", "get", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/navigation", "post", [
            "200",
            "400",
            "401",
            "403",
            "500",
        ]);
    });

    it("documents media not-found and storage-unavailable paths", () => {
        const spec = buildAdminMetadataAccessSpec();

        expectResponses(spec, "/api/v1/admin/media/{id}", "delete", [
            "204",
            "401",
            "403",
            "404",
            "500",
            "503",
        ]);
        expectResponses(spec, "/api/v1/admin/media/upload", "post", [
            "200",
            "201",
            "400",
            "401",
            "403",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/media/move", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "500",
        ]);
        expectResponses(spec, "/api/v1/admin/media/folders/{id}", "delete", [
            "204",
            "401",
            "403",
            "500",
        ]);
    });
});
