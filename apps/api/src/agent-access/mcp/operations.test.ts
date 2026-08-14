import { describe, expect, it } from "vitest";
import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
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
    parameters: [{
      in: "query",
      name: "preview",
      required: false,
      description: "Choose a preview mode",
      schema: { type: "string", enum: ["brief", "full"], default: "brief" },
    }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 255 },
              media: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
            },
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
      query: [{
        name: "preview",
        required: false,
        type: "string",
        enum: ["brief", "full"],
        default: "brief",
        description: "Choose a preview mode",
      }],
      body: {
        required: true,
        contentTypes: ["application/json"],
        requiredProperties: ["name"],
        optionalProperties: ["media"],
        content: [{
          mediaType: "application/json",
          schema: {
            type: "object",
            fields: [
              { name: "name", required: true, type: "string", minLength: 1, maxLength: 255 },
              {
                name: "media",
                required: false,
                type: "array",
                minItems: 1,
                maxItems: 20,
                itemsType: "string",
              },
            ],
          },
        }],
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

  it("keeps live settings and upload contracts actionable without full schemas", () => {
    const email = describeOperation(AGENT_OPERATIONS_BY_ID["dashboard.settings.email_update"]!);
    expect(email.inputContract?.body?.content).toEqual([{
      mediaType: "application/json",
      schema: {
        type: "object",
        fields: [
          { name: "provider", required: false, type: "string", enum: ["cloudflare", "resend"] },
          { name: "apiKey", required: false, type: "string", maxLength: 512 },
          { name: "sender", required: false, type: "string", maxLength: 320 },
        ],
      },
    }]);

    const upload = describeOperation(AGENT_OPERATIONS_BY_ID["dashboard.media.upload_part"]!);
    expect(upload.inputContract?.path).toEqual([
      { name: "id", required: true, type: "string", minLength: 8, maxLength: 160 },
      { name: "partNumber", required: true, type: "integer", minimum: 1, maximum: 20 },
    ]);
    expect(upload.inputContract?.body?.content).toEqual([{
      mediaType: "application/octet-stream",
      schema: { type: "string", format: "binary", minLength: 1, maxLength: 5_242_880 },
    }]);
  });

  it("keeps provider alternatives and their nested credential fields discoverable", () => {
    const providerOperation = {
      ...operation,
      operationId: "dashboard.delivery_providers.create",
      inputSchema: {
        parameters: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    required: ["type", "credentials"],
                    properties: {
                      type: { type: "string", enum: ["pathao"] },
                      credentials: {
                        anyOf: [
                          { type: "string", description: "Legacy dashboard JSON." },
                          {
                            type: "object",
                            properties: {
                              clientId: {
                                type: "string",
                                maxLength: 512,
                                description: "Required before activation.",
                              },
                              deliveryType: { anyOf: [{ const: 48 }, { const: 12 }] },
                            },
                          },
                        ],
                      },
                    },
                  },
                  {
                    type: "object",
                    required: ["type"],
                    properties: { type: { type: "string", enum: ["steadfast"] } },
                  },
                ],
              },
            },
          },
        },
      },
    } satisfies AgentOperationManifestEntry;

    const described = describeOperation(providerOperation);
    const schema = described.inputContract?.body?.content[0]?.schema as {
      variants?: Array<{ fields?: Array<{
        name: string;
        enum?: unknown[];
        variants?: Array<{ fields?: Array<Record<string, unknown>> }>;
      }> }>;
    };
    expect(schema.variants?.map((variant) => variant.fields?.find(({ name }) => name === "type")?.enum)).toEqual([
      ["pathao"],
      ["steadfast"],
    ]);
    expect(schema.variants?.[0]?.fields?.find(({ name }) => name === "credentials")?.variants?.[1]?.fields).toContainEqual({
      name: "clientId",
      required: false,
      type: "string",
      maxLength: 512,
      description: "Required before activation.",
    });
    expect(schema.variants?.[0]?.fields?.find(({ name }) => name === "credentials")?.variants?.[1]?.fields).toContainEqual({
      name: "deliveryType",
      required: false,
      type: "anyOf",
      variants: [
        { type: "literal", value: 48 },
        { type: "literal", value: 12 },
      ],
    });
  });
});
