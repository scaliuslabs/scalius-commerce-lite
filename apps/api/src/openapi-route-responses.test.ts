import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { finalizeOpenApiContract, type OpenApiDocument } from "./openapi-contract";
import { customerAuthRoutes } from "./routes/customer-auth";
import { adminAuthManagementRoutes } from "./routes/admin/auth-management";
import { paymentSettingsRoutes } from "./routes/admin/settings/payments";

type TestOperation = {
  responses?: Record<string, unknown>;
};

function operation(spec: OpenApiDocument, path: string, method: string): TestOperation {
  const pathItem = spec.paths?.[path] as Record<string, TestOperation> | undefined;
  const op = pathItem?.[method];
  if (!op) throw new Error(`Missing test operation ${method.toUpperCase()} ${path}`);
  return op;
}

function generatedSpec(): OpenApiDocument {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/customer-auth", customerAuthRoutes);
  app.route("/admin/auth", adminAuthManagementRoutes);
  app.route("/admin/settings", paymentSettingsRoutes);

  return finalizeOpenApiContract(app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Route response docs", version: "test" },
  })) as unknown as OpenApiDocument;
}

describe("route OpenAPI error responses", () => {
  it.each([
    ["/api/v1/customer-auth/send-otp", "post", ["503"]],
    ["/api/v1/customer-auth/verify-otp", "post", ["503"]],
    ["/api/v1/admin/settings/stripe", "post", ["503"]],
    ["/api/v1/admin/settings/sslcommerz", "post", ["503"]],
    ["/api/v1/admin/settings/polar", "post", ["503"]],
    ["/api/v1/admin/auth/users", "post", ["409", "503"]],
  ])("documents %s %s error statuses", (path, method, statuses) => {
    const responses = operation(generatedSpec(), path, method).responses;

    for (const status of statuses) {
      expect(responses).toHaveProperty(status);
    }
  });
});
