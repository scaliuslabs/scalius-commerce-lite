import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { adminCategoryRoutes } from "./categories";
import { adminCollectionRoutes } from "./collections";
import { adminDiscountRoutes } from "./discounts";
import { adminPageRoutes } from "./pages";

type OperationDoc = {
    responses?: Record<string, unknown>;
};

type TestOpenApiDocument = {
    paths?: Record<string, Record<string, OperationDoc>>;
};

function buildAdminCatalogContentSpec(): TestOpenApiDocument {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.route("/categories", adminCategoryRoutes);
    app.route("/collections", adminCollectionRoutes);
    app.route("/discounts", adminDiscountRoutes);
    app.route("/pages", adminPageRoutes);
    return app.getOpenAPIDocument({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
    }) as unknown as TestOpenApiDocument;
}

function expectResponseStatuses(
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

describe("admin catalog/content mutation OpenAPI responses", () => {
    it("documents category mutation conflicts, validation errors, and guarded restore semantics", () => {
        const spec = buildAdminCatalogContentSpec();

        expectResponseStatuses(spec, "/api/v1/admin/categories", "post", [
            "201",
            "400",
            "401",
            "403",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/categories/{id}", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/categories/{id}/permanent", "delete", [
            "204",
            "401",
            "403",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/categories/{id}/restore", "post", [
            "200",
            "401",
            "403",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/categories/bulk-restore", "post", [
            "204",
            "400",
            "401",
            "403",
            "409",
        ]);
    });

    it("documents collection validation and not-found errors", () => {
        const spec = buildAdminCatalogContentSpec();

        expectResponseStatuses(spec, "/api/v1/admin/collections", "post", [
            "201",
            "400",
            "401",
            "403",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/collections/{id}", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/collections/{id}", "delete", [
            "204",
            "401",
            "403",
            "404",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/collections/{id}/permanent", "delete", [
            "204",
            "401",
            "403",
        ]);
    });

    it("documents page slug conflicts without inventing restore conflicts", () => {
        const spec = buildAdminCatalogContentSpec();

        expectResponseStatuses(spec, "/api/v1/admin/pages", "post", [
            "201",
            "400",
            "401",
            "403",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/pages/{id}", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/pages/{id}/restore", "post", [
            "200",
            "401",
            "403",
        ]);
    });

    it("documents discount code conflicts, restore conflicts, and toggle not-found errors", () => {
        const spec = buildAdminCatalogContentSpec();

        expectResponseStatuses(spec, "/api/v1/admin/discounts", "post", [
            "201",
            "400",
            "401",
            "403",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/discounts/bulk-restore", "post", [
            "204",
            "400",
            "401",
            "403",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/discounts/{id}", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/discounts/{id}", "delete", [
            "204",
            "401",
            "403",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/discounts/{id}/toggle-status", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
        ]);
        expectResponseStatuses(spec, "/api/v1/admin/discounts/{id}/restore", "post", [
            "200",
            "401",
            "403",
            "409",
        ]);
    });
});
