import { describe, expect, it } from "vitest";
import { finalizeOpenApiContract, type OpenApiDocument } from "./openapi-contract";

type TestOperation = {
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, unknown>;
  "x-scalius-agent"?: Record<string, unknown>;
  "x-scalius-rbac"?: Record<string, unknown>;
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
      "/api/v1/admin/agent-access/connections": { get: { responses: {} } },
      "/api/v1/admin/inventory/scanner/lookup": { get: { responses: {} } },
      "/api/v1/cache/groups": {
        get: {
          operationId: "dashboard.cache.groups_list",
          responses: {},
        },
      },
      "/api/v1/auth/token": { get: { responses: {} } },
      "/api/v1/auth/me": { get: { responses: {} } },
      "/api/v1/agent-auth/device/start": { post: { responses: {} } },
      "/api/v1/agent-auth/revoke": { post: { responses: {} } },
      "/api/v1/storefront/agent-continuations/{continuationId}": {
        get: {
          operationId: "system.storefront_continuations.get",
          responses: {},
        },
      },
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
      agentBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "ScaliusAgentCredential",
      },
    });

    expect(operation(spec, "/api/v1/admin/products", "get").security).toEqual([
      { adminSession: [] },
    ]);
    expect(operation(spec, "/api/v1/admin/agent-access/connections", "get").security).toEqual([
      { adminSession: [] },
      { agentBearer: [] },
    ]);
    expect(operation(spec, "/api/v1/admin/inventory/scanner/lookup", "get").security).toEqual([
      { adminSession: [] },
      { scannerSession: [] },
    ]);
    expect(operation(spec, "/api/v1/cache/groups", "get")).toMatchObject({
      operationId: "dashboard.cache.groups_list",
      "x-scalius-agent": { surface: "dashboard" },
      "x-scalius-rbac": {
        type: "permission",
        permission: "settings.cache.view",
      },
    });
    expect(operation(spec, "/api/v1/cache/groups", "get").security).toContainEqual({
      adminSession: [],
    });
    expect(operation(spec, "/api/v1/auth/token", "get").security).toEqual([
      { apiTokenHeader: [] },
    ]);
    expect(operation(spec, "/api/v1/auth/me", "get").security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(operation(spec, "/api/v1/agent-auth/device/start", "post").security).toEqual([]);
    expect(operation(spec, "/api/v1/agent-auth/revoke", "post").security).toEqual([
      { agentBearer: [] },
    ]);
    expect(
      operation(
        spec,
        "/api/v1/storefront/agent-continuations/{continuationId}",
        "get",
      ),
    ).toMatchObject({
      operationId: "system.storefront_continuations.get",
      security: [{ bearerAuth: [] }],
      "x-scalius-agent": {
        surface: "system",
        exposure: "excluded",
        principals: ["internal"],
        exclusionReason: expect.stringContaining("service-JWT"),
      },
      "x-scalius-rbac": { type: "unmapped" },
    });
    expect(operation(spec, "/api/v1/customer-auth/send-otp", "post").security).toEqual([]);
    expect(operation(spec, "/api/v1/customer-auth/me", "get").security).toEqual([
      { customerSession: [] },
    ]);
    expect(operation(spec, "/api/v1/orders/status/{token}", "get").security).toEqual([]);
    expect(operation(spec, "/api/v1/products", "get").security).toEqual([]);
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

  it("assigns stable metadata and derived RBAC without widening unreviewed routes", () => {
    const spec = finalizeOpenApiContract(specWithPaths({
      "/api/v1/admin/products": {
        get: { summary: "List products", tags: ["Products"], responses: {} },
        post: {
          summary: "Create product",
          tags: ["Products"],
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: {},
        },
      },
      "/api/v1/products": {
        get: { summary: "Storefront products", tags: ["Products"], responses: {} },
      },
      "/api/v1/storefront/agent-contexts": {
        post: {
          summary: "Create context",
          tags: ["Agent Contexts"],
          responses: {},
        },
      },
      "/api/v1/agent-auth/device/start": {
        post: {
          summary: "Start device pairing",
          tags: ["Agent Authentication"],
          responses: {},
        },
      },
      "/api/v1/agent-auth/device/token": {
        post: {
          summary: "Poll device pairing",
          tags: ["Agent Authentication"],
          responses: {},
        },
      },
      "/api/v1/agent-auth/device/ack": {
        post: {
          summary: "Acknowledge device pairing",
          tags: ["Agent Authentication"],
          responses: {},
        },
      },
      "/api/v1/agent-auth/revoke": {
        post: {
          summary: "Revoke current credential",
          tags: ["Agent Authentication"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {},
        },
      },
      "/api/v1/admin/orders": {
        get: { summary: "List orders", tags: ["Orders"], responses: {} },
      },
      "/api/v1/admin/agent-access/connections": {
        get: { summary: "List agent connections", tags: ["Agent Access"], responses: {} },
      },
    }));

    expect(operation(spec, "/api/v1/admin/products", "get")).toMatchObject({
      operationId: "dashboard.products.list",
      "x-scalius-agent": { exposure: "excluded", risk: "read" },
      "x-scalius-rbac": { type: "permission", permission: "products.view" },
    });
    expect(operation(spec, "/api/v1/admin/products", "post")).toMatchObject({
      operationId: "dashboard.products.create",
      requestBody: { required: true },
      "x-scalius-agent": { exposure: "execute", risk: "write" },
      "x-scalius-rbac": { type: "permission", permission: "products.create" },
    });
    expect(operation(spec, "/api/v1/products", "get")).toMatchObject({
      operationId: "storefront.products.list",
      "x-scalius-agent": { exposure: "execute", surface: "storefront" },
      "x-scalius-rbac": { type: "public" },
    });
    expect(operation(spec, "/api/v1/products", "get").security).toEqual([]);
    expect(operation(spec, "/api/v1/storefront/agent-contexts", "post")).toMatchObject({
      operationId: "storefront.context.create",
      security: [{ agentBearer: [] }],
      "x-scalius-agent": { exposure: "execute", surface: "storefront" },
      "x-scalius-rbac": { type: "agentGrant" },
    });
    expect(operation(spec, "/api/v1/agent-auth/device/start", "post")).toMatchObject({
      operationId: "system.agent_auth.device_start",
      "x-scalius-agent": {
        exposure: "device",
        surface: "system",
        risk: "security",
        batch: "forbidden",
        sensitiveOutput: true,
      },
      "x-scalius-rbac": { type: "public" },
    });
    expect(operation(spec, "/api/v1/agent-auth/device/token", "post")).toMatchObject({
      operationId: "system.agent_auth.device_token",
      "x-scalius-agent": { exposure: "device", sensitiveOutput: true },
    });
    expect(operation(spec, "/api/v1/agent-auth/device/ack", "post")).toMatchObject({
      operationId: "system.agent_auth.device_ack",
      "x-scalius-agent": {
        exposure: "device",
        idempotency: "supported",
        sensitiveOutput: false,
      },
    });
    expect(operation(spec, "/api/v1/agent-auth/revoke", "post")).toMatchObject({
      operationId: "system.agent_auth.revoke",
      security: [{ agentBearer: [] }],
      requestBody: { required: true },
      "x-scalius-agent": { exposure: "device", risk: "security" },
      "x-scalius-rbac": { type: "agentGrant" },
    });
    expect(operation(spec, "/api/v1/admin/orders", "get")).toMatchObject({
      "x-scalius-agent": {
        exposure: "excluded",
        exclusionReason: expect.any(String),
      },
    });
    expect(operation(spec, "/api/v1/admin/agent-access/connections", "get")).toMatchObject({
      operationId: "dashboard.agent_access.connections.list",
      security: [{ adminSession: [] }, { agentBearer: [] }],
      "x-scalius-agent": {
        exposure: "execute",
        risk: "read",
        batch: "forbidden",
        sensitiveOutput: false,
        oneTimeSecretOutput: false,
      },
      "x-scalius-rbac": {
        type: "permission",
        permission: "agent_access.view",
      },
    });
  });

  it("applies reviewed metadata by a deterministically generated operation ID", () => {
    const spec = finalizeOpenApiContract(specWithPaths({
      "/api/v1/auth/token": {
        get: { responses: {} },
      },
      "/api/v1/customer-auth/verify-otp": {
        post: { responses: {} },
      },
    }));

    expect(operation(spec, "/api/v1/auth/token", "get")).toMatchObject({
      operationId: "system.auth_token.get_token",
      "x-scalius-agent": {
        surface: "system",
        exposure: "excluded",
        principals: ["internal"],
        risk: "security",
        sensitiveOutput: true,
        exclusionReason: expect.stringContaining("service JWT"),
      },
    });
    expect(operation(spec, "/api/v1/customer-auth/verify-otp", "post")).toMatchObject({
      operationId: "storefront.customer_auth_verify_otp.verify_otp",
      "x-scalius-agent": {
        surface: "storefront",
        exposure: "excluded",
        principals: ["visitor", "customer"],
        risk: "security",
        sensitiveOutput: true,
        exclusionReason: expect.stringContaining("raw OTP"),
      },
    });
  });
});
