import { describe, expect, it } from "vitest";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import {
  AgentDispatchError,
  buildAgentOperationPath,
  buildAgentOperationUrl,
  buildAgentRequiredClientAction,
  buildInternalRequest,
  getAgentOperationOutputPolicy,
  shapeAgentOperationOutput,
  shapeSensitiveContinuation,
} from "./dispatch";

function operation(
  overrides: Partial<AgentOperationManifestEntry> = {},
): AgentOperationManifestEntry {
  return {
    operationId: "dashboard.agent_access.tokens.create",
    method: "POST",
    pathTemplate: "/api/v1/admin/agent-access/tokens",
    summary: "Create PAT",
    tags: ["Admin - Agent Access"],
    surface: "dashboard",
    exposure: "execute",
    principals: ["admin"],
    risk: "security",
    openWorld: false,
    idempotency: "none",
    revision: "none",
    batch: "forbidden",
    transport: "json",
    maxResponseBytes: 8192,
    maxRequestBytes: 1024 * 1024,
    sensitiveOutput: true,
    oneTimeSecretOutput: true,
    requiredClientAction: null,
    artifactOutput: null,
    continuationOutput: null,
    rbac: { type: "allowAnyAdmin" },
    inputSchema: {},
    outputSchema: {},
    ...overrides,
  };
}

describe("agent in-process request construction", () => {
  it("substitutes only manifest-owned path and caller-owned values", () => {
    expect(buildAgentOperationPath(
      "/api/v1/storefront/agent-contexts/{contextId}/continuations/{continuationId}",
      { contextId: "asc_a/b", continuationId: "ascn_x y" },
    )).toBe("/api/v1/storefront/agent-contexts/asc_a%2Fb/continuations/ascn_x%20y");
  });

  it("allows JSON-input operations whose reviewed output is a streamed artifact", () => {
    const source = operation({
      operationId: "dashboard.inventory_labels.generate_artifact",
      pathTemplate: "/api/v1/admin/inventory/labels/artifact",
      transport: "json",
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
      artifactOutput: {
        mediaTypes: ["text/csv"],
        disposition: "attachment",
        filenamePolicy: "content-disposition",
        maxArtifactBytes: 16 * 1024 * 1024,
        delivery: "authenticated-handle",
      },
      continuationOutput: null,
    });
    const request = buildInternalRequest(
      source,
      { body: { format: "csv" } },
      { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
      "request-artifact",
    );
    expect(new URL(request.url).pathname)
      .toBe("/api/v1/admin/inventory/labels/artifact");
    expect(request.headers.get("Content-Type")).toBe("application/json");
  });

  it("rejects unknown JSON body properties before a route can silently strip them", async () => {
    const source = operation({
      inputSchema: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  permissions: { type: "array", items: { type: "string" } },
                },
                required: ["name"],
              },
            },
          },
        },
      },
    });
    expect(() => buildInternalRequest(
      source,
      { body: { name: "Catalog editor", permissionKeys: ["products.view"] } },
      { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
      "request-unknown-body",
    )).toThrowError("Unknown body property 'permissionKeys'. Allowed properties: name, permissions.");

    const request = buildInternalRequest(
      source,
      { body: { name: "Catalog editor", permissions: ["products.view"] } },
      { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
      "request-declared-body",
    );
    expect(await request.json()).toEqual({ name: "Catalog editor", permissions: ["products.view"] });
  });

  it("builds the JSON request that initiates a reviewed continuation", async () => {
    const source = operation({
      operationId: "storefront.orders.payment.begin",
      pathTemplate: "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/payment",
      surface: "storefront",
      exposure: "continuation",
      principals: ["visitor", "customer"],
      transport: "continuation",
      sensitiveOutput: true,
      oneTimeSecretOutput: false,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/browser/url",
        fieldsJsonPointer: "/data/browser/fields",
        sensitiveFields: ["continuationCode"],
      },
      rbac: { type: "agentGrant" },
    });
    const request = buildInternalRequest(
      source,
      {
        path: { contextId: "asc_123", orderId: "order_123" },
        body: {},
      },
      { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
      "request-continuation",
    );
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname)
      .toBe("/api/v1/storefront/agent-contexts/asc_123/orders/order_123/payment");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(await request.json()).toEqual({});
  });

  it("fails closed on missing and arbitrary path parameters", () => {
    expect(() => buildAgentOperationPath("/api/v1/admin/products/{id}", {}))
      .toThrowError(AgentDispatchError);
    expect(() => buildAgentOperationPath("/api/v1/admin/products", { route: "setup" }))
      .toThrowError(AgentDispatchError);
  });

  it("uses the configured origin and deterministic primitive query encoding", () => {
    const url = buildAgentOperationUrl(
      "https://api.example.test/untrusted-base-path",
      "/api/v1/products",
      { query: { search: "blue/red", page: 2, include: [true, false], empty: null } },
    );
    expect(url.origin).toBe("https://api.example.test");
    expect(url.pathname).toBe("/api/v1/products");
    expect(url.searchParams.get("search")).toBe("blue/red");
    expect(url.searchParams.getAll("include")).toEqual(["true", "false"]);
    expect(url.searchParams.has("empty")).toBe(false);
  });
});

describe("manifest-driven direct client actions", () => {
  it("describes a fixed bounded octet-stream upload without receiving bytes", () => {
    const action = buildAgentRequiredClientAction(operation({
      operationId: "dashboard.media.upload_part",
      method: "PUT",
      pathTemplate: "/api/v1/admin/media/uploads/{id}/parts/{partNumber}",
      transport: "octet-stream",
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
      requiredClientAction: "direct-upload",
      maxRequestBytes: 5 * 1024 * 1024,
    }), {
      path: { id: "upload_123", partNumber: 2 },
    }, {
      PUBLIC_API_BASE_URL: "https://api.example.test",
    } as Env);
    expect(action).toEqual({
      operationId: "dashboard.media.upload_part",
      executed: false,
      requiredClientAction: {
        kind: "direct-upload",
        method: "PUT",
        url: "https://api.example.test/api/v1/admin/media/uploads/upload_123/parts/2",
        mediaType: "application/octet-stream",
        maxRequestBytes: 5 * 1024 * 1024,
        requiresBearerHeader: true,
      },
    });
    expect(action.requiredClientAction.url).not.toContain("token");
  });

  it("rejects bytes in MCP input and malformed action policy", () => {
    const direct = operation({
      operationId: "dashboard.media.upload_part",
      transport: "octet-stream",
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
      requiredClientAction: "direct-upload",
    });
    expect(() => buildAgentRequiredClientAction(
      direct,
      { body: "base64-is-forbidden" },
      { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
    )).toThrow(AgentDispatchError);
    expect(() => buildAgentRequiredClientAction(
      { ...direct, batch: "sequential" },
      {},
      { PUBLIC_API_BASE_URL: "https://api.example.test" } as Env,
    )).toThrow(AgentDispatchError);
  });
});

describe("agent operation output policy", () => {
  it("returns a bounded one-time secret only for a successful reviewed operation", () => {
    const body = JSON.stringify({ token: "scl_pat_once", connection: { id: "agr_x" } });
    expect(shapeAgentOperationOutput(
      operation(),
      true,
      body,
      "application/json",
    )).toEqual({
      data: { token: "scl_pat_once", connection: { id: "agr_x" } },
      oneTimeSecret: true,
    });
  });

  it("redacts ordinary sensitive output and every non-2xx one-time response", () => {
    expect(shapeAgentOperationOutput(
      operation({ oneTimeSecretOutput: false }),
      true,
      JSON.stringify({ token: "ordinary-secret" }),
      "application/json",
    )).toEqual({ data: null, redacted: true });
    expect(shapeAgentOperationOutput(
      operation(),
      false,
      JSON.stringify({ token: "partial-secret", error: "write failed" }),
      "application/json",
    )).toEqual({ data: null, redacted: true });
  });

  it("returns a secure POST continuation once without moving fields into the URL", () => {
    const body = JSON.stringify({
      success: true,
      data: {
        continuation: {
          url: "https://storefront.example.test/theme-preview/continue",
          method: "POST",
          fields: {
            continuationCode: `tpc_${"a".repeat(48)}`,
            path: "/search?q=lamp",
            device: "mobile",
          },
        },
      },
    });
    const continuation = operation({
      operationId: "dashboard.theme.preview_session_create",
      exposure: "continuation",
      transport: "continuation",
      risk: "read",
      sensitiveOutput: true,
      oneTimeSecretOutput: false,
      batch: "forbidden",
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/continuation/url",
        fieldsJsonPointer: "/data/continuation/fields",
        sensitiveFields: ["continuationCode"],
      },
    });
    const shaped = shapeSensitiveContinuation(
      continuation,
      true,
      body,
      "application/json",
      { STOREFRONT_URL: "https://storefront.example.test" },
    );
    expect(shaped.sensitiveContinuation).toBe(true);
    expect(JSON.stringify(shaped.data)).toContain(`tpc_${"a".repeat(48)}`);
    expect(JSON.stringify(shaped.data)).not.toContain("?continuationCode=");
    expect(shaped.data).toMatchObject({
      continuation: {
        url: "https://storefront.example.test/theme-preview/continue",
        method: "POST",
      },
    });
  });

  it("rejects an off-storefront continuation URL", () => {
    const continuation = operation({
      operationId: "dashboard.theme.preview_session_create",
      exposure: "continuation",
      transport: "continuation",
      risk: "read",
      sensitiveOutput: true,
      oneTimeSecretOutput: false,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/continuation/url",
        fieldsJsonPointer: "/data/continuation/fields",
        sensitiveFields: ["continuationCode"],
      },
    });
    expect(() => shapeSensitiveContinuation(
      continuation,
      true,
      JSON.stringify({
        data: {
          continuation: {
            url: "https://attacker.example/collect",
            fields: { continuationCode: "secret" },
          },
        },
      }),
      "application/json",
      { STOREFRONT_URL: "https://storefront.example.test" },
    )).toThrow(AgentDispatchError);
  });

  it("fails closed on a forged storefront, continuation, or batchable secret policy", () => {
    expect(() => getAgentOperationOutputPolicy(operation({ surface: "storefront" }))).toThrow(
      AgentDispatchError,
    );
    expect(() => getAgentOperationOutputPolicy(operation({ exposure: "continuation" }))).toThrow(
      AgentDispatchError,
    );
    expect(() => getAgentOperationOutputPolicy(operation({ batch: "sequential" }))).toThrow(
      AgentDispatchError,
    );
    expect(() => getAgentOperationOutputPolicy(operation({
      operationId: "dashboard.agent_access.grants.revoke",
    }))).toThrow(AgentDispatchError);
    expect(() => getAgentOperationOutputPolicy(operation({
      maxResponseBytes: 16_385,
    }))).toThrow(AgentDispatchError);
  });
});
