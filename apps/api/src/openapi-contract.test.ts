import { describe, expect, it } from "vitest";
import { finalizeOpenApiContract, type OpenApiDocument } from "./openapi-contract";

type TestOperation = {
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, unknown>;
};

function operation(spec: OpenApiDocument, path: string, method: string): TestOperation {
  const pathItem = spec.paths?.[path] as Record<string, TestOperation> | undefined;
  const op = pathItem?.[method];
  if (!op) throw new Error(`Missing test operation ${method.toUpperCase()} ${path}`);
  return op;
}

function specWithPaths(paths: OpenApiDocument["paths"]): OpenApiDocument {
  return {
    openapi: "3.0.0",
    info: { title: "Test", version: "1.0.0" },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    paths,
  };
}

describe("finalizeOpenApiContract", () => {
  it("adds truthful security schemes and operation security from runtime middleware rules", () => {
    const spec = finalizeOpenApiContract(specWithPaths({
      "/api/v1/admin/products": { get: { responses: {} } },
      "/api/v1/admin/inventory/scanner/lookup": { get: { responses: {} } },
      "/api/v1/auth/token": { get: { responses: {} } },
      "/api/v1/auth/me": { get: { responses: {} } },
      "/api/v1/customer-auth/send-otp": { post: { responses: {} } },
      "/api/v1/customer-auth/me": { get: { responses: {} } },
      "/api/v1/orders/status/{token}": { get: { responses: {} } },
      "/api/v1/products": { get: { responses: {} } },
      "/api/v1/admin/explicit-public": { get: { security: [], responses: {} } },
    }));

    expect(spec.components?.securitySchemes).toMatchObject({
      apiTokenHeader: { type: "apiKey", in: "header", name: "X-API-Token" },
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      adminSession: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      scannerSession: { type: "apiKey", in: "cookie", name: "scanner_sid" },
      customerSession: { type: "apiKey", in: "cookie", name: "cs_tok" },
    });

    expect(operation(spec, "/api/v1/admin/products", "get").security).toEqual([
      { adminSession: [] },
    ]);
    expect(operation(spec, "/api/v1/admin/inventory/scanner/lookup", "get").security).toEqual([
      { adminSession: [] },
      { scannerSession: [] },
    ]);
    expect(operation(spec, "/api/v1/auth/token", "get").security).toEqual([
      { apiTokenHeader: [] },
    ]);
    expect(operation(spec, "/api/v1/auth/me", "get").security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(operation(spec, "/api/v1/customer-auth/send-otp", "post").security).toBeUndefined();
    expect(operation(spec, "/api/v1/customer-auth/me", "get").security).toEqual([
      { customerSession: [] },
    ]);
    expect(operation(spec, "/api/v1/orders/status/{token}", "get").security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(operation(spec, "/api/v1/products", "get").security).toBeUndefined();
    expect(operation(spec, "/api/v1/admin/explicit-public", "get").security).toEqual([]);
  });

  it("documents known conflict and unavailable responses without replacing route-specific docs", () => {
    const existingUnavailable = { description: "Gateway unavailable" };
    const spec = finalizeOpenApiContract(specWithPaths({
      "/api/v1/setup": { post: { responses: {} } },
      "/api/v1/admin/rbac/roles": { post: { responses: {} } },
      "/api/v1/payment/stripe/intent": {
        post: { responses: { "503": existingUnavailable } },
      },
    }));

    expect(operation(spec, "/api/v1/setup", "post").responses).toHaveProperty("409");
    expect(operation(spec, "/api/v1/setup", "post").responses).toHaveProperty("503");
    expect(operation(spec, "/api/v1/admin/rbac/roles", "post").responses).toHaveProperty("409");
    expect(operation(spec, "/api/v1/payment/stripe/intent", "post").responses).toHaveProperty("409");
    expect(operation(spec, "/api/v1/payment/stripe/intent", "post").responses?.["503"]).toBe(existingUnavailable);
  });

  it("also supports already-stripped paths for route-level documents", () => {
    const spec = finalizeOpenApiContract(specWithPaths({
      "/admin/settings": { get: { responses: {} } },
      "/customer-auth/profile": { patch: { responses: {} } },
    }));

    expect(operation(spec, "/admin/settings", "get").security).toEqual([{ adminSession: [] }]);
    expect(operation(spec, "/customer-auth/profile", "patch").security).toEqual([
      { customerSession: [] },
    ]);
  });
});
