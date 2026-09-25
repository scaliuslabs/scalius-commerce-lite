import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { ORDER_STATUSES } from "@scalius/shared/order-state";
import { adminOrdersRoutes } from "./orders";

type OperationDoc = {
    responses?: Record<string, unknown>;
    parameters?: Array<{ name?: string; in?: string }>;
    requestBody?: { content?: { "application/json"?: { schema?: OpenApiSchema } } };
};

type OpenApiSchema = {
    required?: string[];
    enum?: unknown[];
    properties?: Record<string, OpenApiSchema>;
    items?: OpenApiSchema;
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

function expectQueryParameters(
    spec: TestOpenApiDocument,
    path: string,
    method: string,
    expectedNames: string[],
): void {
    const operation = spec.paths?.[path]?.[method];
    if (!operation) throw new Error(`Missing OpenAPI operation ${method.toUpperCase()} ${path}`);
    const actualNames = operation.parameters
        ?.filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name)
        .filter((name): name is string => name !== undefined) ?? [];
    expect(actualNames.sort()).toEqual([...expectedNames].sort());
}

describe("admin order mutation OpenAPI responses", () => {
    it("documents bounded server-side CSV and printable invoice artifacts", () => {
        const spec = buildAdminOrdersSpec();
        expectResponses(spec, "/api/v1/admin/orders/export", "get", ["200", "400", "401", "403"]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/invoice/print", "get", [
            "200", "400", "401", "403", "404", "409", "503",
        ]);
        expect(spec.paths?.["/api/v1/admin/orders/{id}/invoice"]).toHaveProperty("get");
        expect(spec.paths?.["/api/v1/admin/orders/{id}/invoice"]).toHaveProperty("post");
    });

    it("keeps list, recovery-queue, and payment-attempt views free of provider claim secrets", () => {
        const spec = buildAdminOrdersSpec();
        const schemaOf = (path: string) => JSON.stringify(
            (spec.paths?.[path]?.get?.responses?.["200"] as { content?: unknown } | undefined)?.content,
        );
        for (const path of ["/api/v1/admin/orders", "/api/v1/admin/orders/payment-recovery"]) {
            const list = schemaOf(path);
            expect(list).toContain("activeRefundOperation");
            expect(list).toContain("shipmentRecovery");
            for (const secret of ["refundAttempts", "providerRefundId", "lastError", "shipmentClaimId", "attemptKey"]) {
                expect(list, `${path} leaks ${secret}`).not.toContain(`"${secret}"`);
            }
        }
        const payments = schemaOf("/api/v1/admin/orders/{id}/payments");
        expect(payments).toContain("paymentSessionAttempts");
        for (const secret of ["attemptKey", "requestHash", "responsePayload", "claimId"]) {
            expect(payments, `payments leaks ${secret}`).not.toContain(`"${secret}"`);
        }
    });

    it("accepts every concurrently active order-list filter on recovery export", () => {
        const spec = buildAdminOrdersSpec();
        expectQueryParameters(
            spec,
            "/api/v1/admin/orders/payment-recovery/export",
            "get",
            [
                "search", "state", "status", "paymentStatus",
                "paymentMethod", "fulfillmentStatus", "archived", "sort", "order",
                "startDate", "endDate", "maxRows",
            ],
        );
    });

    it("documents the bounded manual-order catalog search", () => {
        const spec = buildAdminOrdersSpec();
        expectResponses(spec, "/api/v1/admin/orders/catalog-products", "get", [
            "200",
            "400",
            "401",
            "403",
        ]);
    });

    it("documents the authoritative manual-order quote before creation", () => {
        const spec = buildAdminOrdersSpec();
        expectResponses(spec, "/api/v1/admin/orders/quote", "post", [
            "200",
            "400",
            "401",
            "403",
            "503",
        ]);
    });

    it("documents guarded manual COD amendment preview and confirmation", () => {
        const spec = buildAdminOrdersSpec();
        expectResponses(spec, "/api/v1/admin/orders/{id}/amendments/preview", "post", [
            "200", "400", "401", "403", "404", "409", "503",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/amendments", "post", [
            "200", "400", "401", "403", "404", "409", "503",
        ]);
        const confirm = spec.paths?.["/api/v1/admin/orders/{id}/amendments"]?.post;
        expect(confirm?.parameters).toContainEqual(expect.objectContaining({
            name: "idempotency-key",
            in: "header",
        }));
    });

    it("requires selectedOptions on every order-form SKU", () => {
        const spec = buildAdminOrdersSpec();
        const operation = spec.paths?.["/api/v1/admin/orders/{id}/form-data"]?.get;
        const response = operation?.responses?.["200"] as {
            content?: Record<string, { schema?: OpenApiSchema }>;
        } | undefined;
        const responseSchema = response?.content?.["application/json"]?.schema;
        const variantSchema = responseSchema?.properties?.data
            ?.properties?.productsWithVariants?.items
            ?.properties?.variants?.items;

        expect(variantSchema?.required).toContain("selectedOptions");
    });

    it("documents representative order, refund, return, COD, and fulfillment failures", () => {
        const spec = buildAdminOrdersSpec();

        expectResponses(spec, "/api/v1/admin/orders/{id}/details", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/archive", "post", [
            "204",
            "400",
            "401",
            "403",
            "409",
        ]);
        expect(spec.paths?.["/api/v1/admin/orders/{id}"]?.delete).toBeUndefined();
        expect(spec.paths?.["/api/v1/admin/orders/{id}/permanent"]).toBeUndefined();
        expectResponses(spec, "/api/v1/admin/orders/{id}/payment-recovery-link", "post", [
            "201",
            "400",
            "401",
            "403",
            "404",
            "409",
            "503",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/status", "put", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expect(
            spec.paths?.["/api/v1/admin/orders/{id}/status"]?.put
                ?.requestBody?.content?.["application/json"]?.schema
                ?.properties?.status?.enum,
        ).toEqual(ORDER_STATUSES);
        expectResponses(spec, "/api/v1/admin/orders/{id}/cod", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/fulfillments", "post", [
            "201",
            "400",
            "401",
            "403",
            "404",
            "409",
            "503",
        ]);
        expect(spec.paths?.["/api/v1/admin/orders/{id}/fulfill"]).toBeUndefined();
        expect(spec.paths?.["/api/v1/admin/orders/{id}/shipments/{shipmentId}/returned"]).toBeUndefined();
        expectResponses(spec, "/api/v1/admin/orders/{id}/returns", "post", [
            "201",
            "400",
            "401",
            "403",
            "404",
            "409",
            "503",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/returns/{returnId}/receive", "post", [
            "200",
            "400",
            "401",
            "403",
            "404",
            "409",
            "503",
        ]);
        expectResponses(spec, "/api/v1/admin/orders/{id}/returns/{returnId}/reconcile", "post", [
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
        // Fulfillment aggregate state is owned by shipment workflows, never a manual override.
        expect(spec.paths?.["/api/v1/admin/orders/{id}/fulfillment-status"]).toBeUndefined();
        expectResponses(spec, "/api/v1/admin/orders/{id}/shipments/{shipmentId}/reconcile", "post", [
            "200", "400", "401", "403", "404", "409", "503",
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
