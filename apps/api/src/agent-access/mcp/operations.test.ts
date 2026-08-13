import { describe, expect, it } from "vitest";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { describeOperation } from "./operations";

const operation = {
  operationId: "dashboard.products.create",
  method: "POST",
  pathTemplate: "/api/v1/admin/products",
  summary: "Create a product",
  description: "Create the complete product atomically.",
  tags: ["Products"],
  surface: "dashboard",
  exposure: "execute",
  principals: ["admin"],
  risk: "write",
  openWorld: false,
  idempotency: "none",
  revision: "none",
  batch: "sequential",
  transport: "json",
  maxResponseBytes: 16_384,
  maxRequestBytes: 1_048_576,
  sensitiveOutput: false,
  oneTimeSecretOutput: false,
  requiredClientAction: null,
  artifactOutput: null,
  continuationOutput: null,
  rbac: { type: "permission", permission: "products.create" },
  inputSchema: {
    parameters: [{ in: "query", name: "preview", required: false }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { name: { type: "string" }, media: { type: "array" } },
            required: ["name"],
          },
        },
      },
    },
  },
  outputSchema: { type: "object", properties: { success: { type: "boolean" } } },
} satisfies AgentOperationManifestEntry;

describe("MCP operation descriptions", () => {
  it("defaults to a compact actionable contract", () => {
    const described = describeOperation(operation);
    expect(described.inputContract).toEqual({
      path: [],
      query: [{ name: "preview", required: false }],
      body: {
        required: true,
        contentTypes: ["application/json"],
        requiredProperties: ["name"],
        optionalProperties: ["media"],
      },
    });
    expect(described).not.toHaveProperty("inputSchema");
    expect(described).not.toHaveProperty("outputSchema");
  });

  it("returns exact schemas only when explicitly requested", () => {
    const described = describeOperation(operation, true);
    expect(described.inputSchema).toEqual(operation.inputSchema);
    expect(described.outputSchema).toEqual(operation.outputSchema);
  });
});
