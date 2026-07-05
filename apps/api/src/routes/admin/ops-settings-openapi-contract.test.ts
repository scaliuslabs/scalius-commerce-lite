import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { finalizeOpenApiContract, type OpenApiDocument } from "../../openapi-contract";
import { cacheControlRoutes } from "../cache";
import { adminFraudCheckerRoutes } from "./fraud-checker";
import { adminSearchRoutes } from "./search";
import { deliveryProvidersRoutes } from "./settings/delivery-providers";
import { shippingMethodsSettingsRoutes } from "./settings/shipping";

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

function buildOpsSettingsSpec(): OpenApiDocument {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  app.route("/admin/settings/shipping-methods", shippingMethodsSettingsRoutes);
  app.route("/admin/settings/delivery-providers", deliveryProvidersRoutes);
  app.route("/admin/fraud-checker", adminFraudCheckerRoutes);
  app.route("/admin/search", adminSearchRoutes);
  app.route("/cache", cacheControlRoutes);

  return finalizeOpenApiContract(app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Ops/settings route response docs", version: "test" },
  })) as unknown as OpenApiDocument;
}

describe("ops/settings OpenAPI mutation responses", () => {
  it("documents route-local conflict and unavailable failures without broadening provider tests", () => {
    const spec = buildOpsSettingsSpec();

    expectResponses(spec, "/api/v1/admin/settings/shipping-methods", "post", ["201", "400", "401", "403", "409"]);

    expectResponses(spec, "/api/v1/admin/settings/shipping-methods/{id}", "put", ["200", "400", "401", "403", "404", "409"]);

    expectResponses(spec, "/api/v1/admin/settings/delivery-providers", "post", ["201", "400", "401", "403", "503"]);
    expectResponses(spec, "/api/v1/admin/settings/delivery-providers", "put", ["200", "201", "400", "401", "403", "503"]);
    expectResponses(spec, "/api/v1/admin/settings/delivery-providers/{id}", "post", ["200", "400", "401", "403", "404"]);

    expectResponses(spec, "/api/v1/admin/fraud-checker", "post", ["201", "400", "401", "403", "503"]);
    expectResponses(spec, "/api/v1/admin/fraud-checker", "put", ["200", "400", "401", "403", "503"]);
    expectResponses(spec, "/api/v1/admin/fraud-checker/{id}", "delete", ["200", "400", "401", "403", "404"]);
    expectResponses(spec, "/api/v1/admin/fraud-checker/{id}/test", "post", ["200", "400", "401", "403", "404"]);
    expectResponses(spec, "/api/v1/admin/fraud-checker/lookup", "post", ["200", "400", "401", "403", "404", "503"]);

    expectResponses(spec, "/api/v1/admin/search", "get", ["200", "400", "401", "403", "503"]);

    expectResponses(spec, "/api/v1/cache/storefront-dlq/{id}/replay", "post", ["200", "400", "401", "403", "404", "409", "503"]);
    expectResponses(spec, "/api/v1/cache/storefront-dlq/{id}/ignore", "post", ["200", "400", "401", "403", "409"]);
  });
});
