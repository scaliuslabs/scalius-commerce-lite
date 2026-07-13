import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { finalizeOpenApiContract, type OpenApiDocument } from "../../openapi-contract";
import { adminCustomerRoutes } from "./customers";
import { adminInventoryRoutes } from "./inventory";
import { adminShipmentRoutes } from "./shipments";
import { heroSlidersRoutes } from "./settings/hero-sliders";
import { metaConversionsAdminRoutes } from "./settings/meta-conversions-admin";
import { smsSettingsRoutes } from "./settings/sms";
import { systemSettingsRoutes } from "./settings/system";

type OperationDoc = {
  responses?: Record<string, unknown>;
};

function operation(spec: OpenApiDocument, path: string, method: string): OperationDoc {
  const pathItem = spec.paths?.[path] as Record<string, OperationDoc> | undefined;
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

function expectNoResponses(
  spec: OpenApiDocument,
  path: string,
  method: string,
  statuses: string[],
): void {
  const responses = operation(spec, path, method).responses;
  for (const status of statuses) {
    expect(responses, `${method.toUpperCase()} ${path} should not document ${status}`).not.toHaveProperty(status);
  }
}

function buildResidualSpec(): OpenApiDocument {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  app.route("/admin/customers", adminCustomerRoutes);
  app.route("/admin/inventory", adminInventoryRoutes);
  app.route("/admin/shipments", adminShipmentRoutes);
  app.route("/admin/settings/hero-sliders", heroSlidersRoutes);
  app.route("/admin/settings/meta-conversions", metaConversionsAdminRoutes);
  app.route("/admin/settings", smsSettingsRoutes);
  app.route("/admin/settings", systemSettingsRoutes);

  return finalizeOpenApiContract(app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Residual admin route response docs", version: "test" },
  })) as unknown as OpenApiDocument;
}

describe("admin residual OpenAPI mutation responses", () => {
  it("documents verified inventory and shipment conflict/unavailable failures", () => {
    const spec = buildResidualSpec();

    expectResponses(spec, "/api/v1/admin/inventory/{variantId}/adjust", "post", ["200", "404", "409"]);

    expectResponses(spec, "/api/v1/admin/inventory/stock-adjust", "post", ["200", "404", "409"]);

    expectResponses(spec, "/api/v1/admin/inventory/stock-set", "post", ["200", "404", "409"]);

    expectResponses(spec, "/api/v1/admin/shipments/{id}", "get", ["200", "404"]);
    expectNoResponses(spec, "/api/v1/admin/shipments/{id}", "get", ["409"]);
    expectResponses(spec, "/api/v1/admin/shipments/{id}", "delete", ["200", "404", "409"]);

    expectResponses(spec, "/api/v1/admin/shipments/{id}/check-status", "post", [
      "200",
      "404",
      "409",
      "503",
    ]);
  });

  it("documents verified settings and customer mutation failures", () => {
    const spec = buildResidualSpec();

    expectResponses(spec, "/api/v1/admin/settings/hero-sliders", "post", ["201", "409"]);
    expectResponses(spec, "/api/v1/admin/settings/hero-sliders/{id}", "put", ["200", "409"]);
    expectResponses(spec, "/api/v1/admin/settings/hero-sliders/{id}", "delete", ["200", "409"]);

    expectResponses(spec, "/api/v1/admin/settings/auth", "post", ["200", "503"]);
    expectResponses(spec, "/api/v1/admin/settings/checkout-flow", "get", ["200"]);
    expectResponses(spec, "/api/v1/admin/settings/checkout-flow", "put", ["200", "409"]);
    expectResponses(spec, "/api/v1/admin/settings/email", "post", ["200", "503"]);
    expectResponses(spec, "/api/v1/admin/settings/firebase", "post", ["200", "503"]);
    expectResponses(spec, "/api/v1/admin/settings/sms", "post", ["200", "503"]);
    expectResponses(spec, "/api/v1/admin/settings/meta-conversions", "post", ["200", "201", "503"]);
    expectResponses(spec, "/api/v1/admin/customers/{id}", "delete", ["204", "404"]);
  });
});
