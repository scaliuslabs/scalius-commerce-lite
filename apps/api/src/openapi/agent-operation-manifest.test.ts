import { describe, expect, it } from "vitest";

import {
  buildAgentOperationManifest,
  parseAgentOperationMetadata,
  renderAgentOperationManifestModule,
  type AgentOperationMetadata,
} from "./agent-operation-manifest";
import { buildAgentWorkflowCatalog } from "../agent-access/workflows";
import { assertNoGenericPendingAgentOperations } from "./generate-agent-operation-manifest";

const reviewedRead: AgentOperationMetadata = {
  surface: "dashboard",
  exposure: "execute",
  principals: ["admin"],
  risk: "read",
  openWorld: false,
  idempotency: "none",
  revision: "none",
  batch: "parallel",
  transport: "json",
  maximumResponseBytes: 65_536,
  maxRequestBytes: 1024 * 1024,
  sensitiveOutput: false,
  oneTimeSecretOutput: false,
};

function manifestOperation(
  operationId: string,
  metadata: AgentOperationMetadata = reviewedRead,
) {
  return {
    operationId,
    description: "Use this operation to create a complete product with variants.",
    responses: {
      200: {
        content: {
          "application/json": { schema: { type: "object" } },
        },
      },
    },
    "x-scalius-agent": metadata,
    "x-scalius-rbac": {
      type: "permission",
      permission: "products.view",
    },
  };
}

describe("stable manifest identity", () => {
  it("retains bounded on-demand guidance without adding it to metadata", () => {
    const [operation] = buildAgentOperationManifest({
      paths: { "/api/v1/admin/a": { post: manifestOperation("dashboard.a.create") } },
    });
    expect(operation?.description).toContain("complete product");
    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/a": {
          post: { ...manifestOperation("dashboard.a.create"), description: "x".repeat(4_097) },
        },
      },
    })).toThrowError(/description of at most 4096/);
  });

  it("sorts records deterministically and renders without timestamps", () => {
    const manifest = buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/z": {
          get: manifestOperation("dashboard.z.get"),
        },
        "/api/v1/admin/a": {
          get: manifestOperation("dashboard.a.get"),
        },
      },
    });
    expect(manifest.map((operation) => operation.operationId)).toEqual([
      "dashboard.a.get",
      "dashboard.z.get",
    ]);
    const catalog = buildAgentWorkflowCatalog(manifest);
    const first = renderAgentOperationManifestModule(manifest, catalog);
    expect(renderAgentOperationManifestModule(manifest, catalog)).toBe(first);
    expect(first).toContain("export const AGENT_WORKFLOW_CATALOG");
    expect(first).toContain(JSON.stringify(catalog.version));
    expect(first).not.toMatch(/generatedAt|new Date\(|20\d\d-\d\d-\d\dT/);
  });

  it("rejects duplicate IDs, surface-prefix drift, and executable unmapped RBAC", () => {
    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/a": {
          get: manifestOperation("dashboard.same.get"),
        },
        "/api/v1/admin/b": {
          get: manifestOperation("dashboard.same.get"),
        },
      },
    })).toThrowError(/Duplicate OpenAPI operationId/);

    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/a": {
          get: manifestOperation("storefront.a.get"),
        },
      },
    })).toThrowError(/surface dashboard; its operationId prefix must match/);

    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/a": {
          get: {
            ...manifestOperation("dashboard.a.get"),
            "x-scalius-rbac": { type: "unmapped" },
          },
        },
      },
    })).toThrowError(/cannot be execute with unmapped RBAC/);
  });

  it("rejects surface authority widening for executable operations", () => {
    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/public": {
          get: {
            ...manifestOperation("dashboard.public.get"),
            "x-scalius-rbac": { type: "public" },
          },
        },
      },
    })).toThrowError(/invalid dashboard executable authority/);

    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/customer-only": {
          get: {
            ...manifestOperation("storefront.customer.get", {
              ...reviewedRead,
              surface: "storefront",
              principals: ["admin"],
            }),
            "x-scalius-rbac": { type: "public" },
          },
        },
      },
    })).toThrowError(/invalid storefront executable authority/);

    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/system": {
          get: manifestOperation("system.internal.get", {
            ...reviewedRead,
            surface: "system",
            principals: ["internal"],
          }),
        },
      },
    })).toThrowError(/cannot expose a system operation/);
  });
});

describe("manifest release classification", () => {
  it.each([
    "Pending operation-specific parity, authority, and output review.",
    "Authority review pending.",
    "This operation is unreviewed.",
    "Awaiting review before agent exposure.",
    "Requires explicit reviewed agent metadata before exposure.",
  ])("rejects generic pending reason %s", (exclusionReason) => {
    const entry = buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/pending": {
          get: manifestOperation("dashboard.pending.get", {
            ...reviewedRead,
            exposure: "excluded",
            batch: "forbidden",
            exclusionReason,
          }),
        },
      },
    });
    expect(() => assertNoGenericPendingAgentOperations(entry)).toThrowError(
      /generic pending classifications: dashboard\.pending\.get/,
    );
  });

  it("accepts a concrete reviewed exclusion", () => {
    const entry = buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/legacy": {
          get: manifestOperation("dashboard.legacy.get", {
            ...reviewedRead,
            exposure: "excluded",
            batch: "forbidden",
            exclusionReason:
              "Legacy duplicate; use dashboard.products.get_section.",
          }),
        },
      },
    });
    expect(() => assertNoGenericPendingAgentOperations(entry)).not.toThrow();
  });
});

describe("device operation metadata", () => {
  it("accepts only explicitly reviewed security ceremonies", () => {
    expect(parseAgentOperationMetadata(
      {
        ...reviewedOneTimeSecret,
        exposure: "device",
        sensitiveOutput: true,
        oneTimeSecretOutput: false,
      },
      "dashboard.scanner_device.create_link",
    )).toMatchObject({ exposure: "device", risk: "security" });

    expect(() => parseAgentOperationMetadata(
      {
        ...reviewedOneTimeSecret,
        exposure: "device",
        sensitiveOutput: false,
        oneTimeSecretOutput: false,
      },
      "dashboard.arbitrary.device",
    )).toThrowError(/device operation policy/);
  });
});

const reviewedOneTimeSecret: AgentOperationMetadata = {
  surface: "dashboard",
  exposure: "execute",
  principals: ["admin"],
  risk: "security",
  openWorld: false,
  idempotency: "none",
  revision: "none",
  batch: "forbidden",
  transport: "json",
  maximumResponseBytes: 16_384,
  maxRequestBytes: 1024 * 1024,
  sensitiveOutput: true,
  oneTimeSecretOutput: true,
};

describe("one-time secret operation metadata", () => {
  it("accepts only the two reviewed PAT create and rotate operations", () => {
    for (const operationId of [
      "dashboard.agent_access.tokens.create",
      "dashboard.agent_access.tokens.rotate",
    ]) {
      expect(
        parseAgentOperationMetadata(reviewedOneTimeSecret, operationId),
      ).toMatchObject({
        sensitiveOutput: true,
        oneTimeSecretOutput: true,
      });
    }

    expect(() =>
      parseAgentOperationMetadata(
        reviewedOneTimeSecret,
        "dashboard.unreviewed.secret",
      ),
    ).toThrowError(/oneTimeSecretOutput policy/);
  });

  it.each([
    ["sensitive output", { sensitiveOutput: false }],
    ["dashboard surface", { surface: "system" }],
    ["execute exposure", { exposure: "device" }],
    ["admin principal", { principals: ["visitor"] }],
    ["only the admin principal", { principals: ["admin", "visitor"] }],
    ["JSON transport", { transport: "multipart" }],
    ["no idempotency policy", { idempotency: "required" }],
    ["no revision policy", { revision: "required" }],
    ["forbidden batching", { batch: "sequential" }],
    ["bounded output", { maximumResponseBytes: 16_385 }],
  ] as const)("rejects one-time secret output without %s", (_label, override) => {
    expect(() =>
      parseAgentOperationMetadata(
        { ...reviewedOneTimeSecret, ...override },
        "dashboard.agent_access.tokens.create",
      ),
    ).toThrowError(/oneTimeSecretOutput policy/);
  });

  it("defaults the flag to false and keeps ordinary sensitive output distinct", () => {
    const { oneTimeSecretOutput: _oneTimeSecretOutput, ...ordinarySensitive } =
      reviewedOneTimeSecret;
    expect(
      parseAgentOperationMetadata(
        { ...ordinarySensitive, exposure: "device", surface: "system" },
        "system.agent_auth.device_token",
      ),
    ).toMatchObject({
      sensitiveOutput: true,
      oneTimeSecretOutput: false,
    });
  });
});

describe("artifact operation metadata", () => {
  const artifactOutput = {
    mediaTypes: ["application/pdf", "text/csv"],
    disposition: "attachment" as const,
    filenamePolicy: "content-disposition" as const,
    maxArtifactBytes: 16 * 1024 * 1024,
    delivery: "authenticated-handle" as const,
  };

  it("normalizes reviewed artifact policy into the generated manifest", () => {
    const manifest = buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/inventory/labels/artifact": {
          post: {
            operationId: "dashboard.inventory_labels.generate_artifact",
            responses: {
              200: { content: { "application/pdf": { schema: { type: "string" } } } },
            },
            "x-scalius-agent": {
              ...reviewedOneTimeSecret,
              risk: "read",
              sensitiveOutput: false,
              oneTimeSecretOutput: false,
              batch: "forbidden",
              artifactOutput,
            },
            "x-scalius-rbac": { type: "permission", permission: "inventory.view" },
          },
        },
      },
    });

    expect(manifest[0]?.artifactOutput).toEqual(artifactOutput);
  });

  it.each([
    ["batching", { batch: "parallel" }],
    ["sensitive redaction", { sensitiveOutput: true }],
    ["one-time secret", { oneTimeSecretOutput: true }],
    ["continuation transport", { transport: "continuation" }],
    ["device exposure", { exposure: "device" }],
  ] as const)("rejects artifact output with %s", (_label, override) => {
    expect(() =>
      parseAgentOperationMetadata(
        {
          ...reviewedOneTimeSecret,
          sensitiveOutput: false,
          oneTimeSecretOutput: false,
          artifactOutput,
          ...override,
        },
        "dashboard.inventory_labels.generate_artifact",
      ),
    ).toThrowError(
      /artifactOutput operation policy|oneTimeSecretOutput policy|parallel batching|device operation policy/,
    );
  });

  it("rejects malformed media, filename, delivery, size, and direct-upload policy", () => {
    for (const invalidArtifact of [
      { ...artifactOutput, mediaTypes: ["text/csv", "text/csv"] },
      { ...artifactOutput, mediaTypes: ["not a media type"] },
      { ...artifactOutput, filenamePolicy: "caller" },
      { ...artifactOutput, delivery: "public-url" },
      { ...artifactOutput, maxArtifactBytes: 16 * 1024 * 1024 + 1 },
    ]) {
      expect(() =>
        parseAgentOperationMetadata(
          {
            ...reviewedOneTimeSecret,
            sensitiveOutput: false,
            oneTimeSecretOutput: false,
            artifactOutput: invalidArtifact,
          },
          "dashboard.inventory_labels.generate_artifact",
        ),
      ).toThrowError(/artifactOutput/);
    }

    expect(() =>
      parseAgentOperationMetadata(
        {
          ...reviewedOneTimeSecret,
          sensitiveOutput: false,
          oneTimeSecretOutput: false,
          transport: "octet-stream",
          batch: "sequential",
          requiredClientAction: "direct-upload",
        },
        "dashboard.media.upload_part",
      ),
    ).toThrowError(/direct-upload policy/);

    expect(() =>
      parseAgentOperationMetadata(
        {
          ...reviewedOneTimeSecret,
          oneTimeSecretOutput: false,
          transport: "octet-stream",
          batch: "forbidden",
        },
        "dashboard.media.upload_part",
      ),
    ).toThrowError(/direct-upload policy/);

    expect(() =>
      parseAgentOperationMetadata(
        {
          ...reviewedOneTimeSecret,
          sensitiveOutput: false,
          oneTimeSecretOutput: false,
          transport: "stream",
          artifactOutput,
        },
        "dashboard.inventory_labels.generate_artifact",
      ),
    ).toThrowError(/invalid x-scalius-agent.transport/);
  });

  it("accepts bounded octet-stream input only as a non-secret direct client action", () => {
    expect(
      parseAgentOperationMetadata(
        {
          ...reviewedOneTimeSecret,
          sensitiveOutput: false,
          oneTimeSecretOutput: false,
          transport: "octet-stream",
          batch: "forbidden",
          maxRequestBytes: 5 * 1024 * 1024,
          requiredClientAction: "direct-upload",
        },
        "dashboard.media.upload_part",
      ),
    ).toMatchObject({
      transport: "octet-stream",
      maxRequestBytes: 5 * 1024 * 1024,
      requiredClientAction: "direct-upload",
    });
  });
});

describe("batch risk policy", () => {
  it.each(["write", "destructive", "financial", "security"] as const)(
    "rejects parallel batching for %s operations",
    (risk) => {
      expect(() => parseAgentOperationMetadata(
        {
          ...reviewedOneTimeSecret,
          risk,
          batch: "parallel",
          sensitiveOutput: false,
          oneTimeSecretOutput: false,
        },
        `dashboard.batch.${risk}`,
      )).toThrowError(/cannot use parallel batching/);
    },
  );

  it("allows parallel batching for bounded reads", () => {
    expect(parseAgentOperationMetadata(
      {
        ...reviewedOneTimeSecret,
        risk: "read",
        batch: "parallel",
        sensitiveOutput: false,
        oneTimeSecretOutput: false,
      },
      "dashboard.batch.read",
    )).toMatchObject({ risk: "read", batch: "parallel" });
  });
});

describe("merchant resource risk policy", () => {
  it.each([
    "dashboard.content.trash",
    "dashboard.orders.archive",
    "dashboard.navigation.items_delete",
    "dashboard.products.delete_permanently",
  ])("requires destructive risk for %s", (operationId) => {
    expect(() => parseAgentOperationMetadata(
      {
        ...reviewedRead,
        risk: "write",
        batch: "sequential",
      },
      operationId,
    )).toThrowError(/must use destructive risk/);

    expect(parseAgentOperationMetadata(
      {
        ...reviewedRead,
        risk: "destructive",
        batch: "sequential",
      },
      operationId,
    )).toMatchObject({ risk: "destructive" });
  });

  it("requires write risk for restore operations", () => {
    expect(() => parseAgentOperationMetadata(
      {
        ...reviewedRead,
        risk: "destructive",
        batch: "sequential",
      },
      "dashboard.content.bulk_restore",
    )).toThrowError(/must use write risk/);

    expect(parseAgentOperationMetadata(
      {
        ...reviewedRead,
        risk: "write",
        batch: "sequential",
      },
      "dashboard.content.bulk_restore",
    )).toMatchObject({ risk: "write" });
  });

  it("does not infer merchant resource risk for excluded operations", () => {
    expect(parseAgentOperationMetadata(
      {
        ...reviewedRead,
        exposure: "excluded",
        risk: "write",
        batch: "forbidden",
        exclusionReason: "Legacy route retained for compatibility.",
      },
      "dashboard.legacy.delete",
    )).toMatchObject({ exposure: "excluded", risk: "write" });
  });
});

describe("sensitive continuation operation metadata", () => {
  const continuationOutput = {
    method: "POST" as const,
    urlJsonPointer: "/data/continuation/url",
    fieldsJsonPointer: "/data/continuation/fields",
    sensitiveFields: ["continuationCode"],
  };

  const reviewedContinuation: AgentOperationMetadata = {
    ...reviewedOneTimeSecret,
    exposure: "continuation",
    risk: "read",
    batch: "forbidden",
    transport: "continuation",
    maximumResponseBytes: 8_192,
    oneTimeSecretOutput: false,
    continuationOutput,
  };

  it("normalizes the reviewed POST continuation pointers in the manifest", () => {
    const manifest = buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/settings/theme/preview-session": {
          post: {
            operationId: "dashboard.theme.preview_session_create",
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        data: {
                          type: "object",
                          properties: {
                            continuation: {
                              type: "object",
                              properties: {
                                url: {
                                  type: "string",
                                  format: "uri",
                                  maxLength: 512,
                                },
                                method: { type: "string", enum: ["POST"] },
                                fields: {
                                  type: "object",
                                  properties: {
                                    continuationCode: {
                                      type: "string",
                                      minLength: 52,
                                      maxLength: 52,
                                      pattern: "^tpc_[A-Za-z0-9_-]{48}$",
                                    },
                                    path: {
                                      type: "string",
                                      minLength: 1,
                                      maxLength: 512,
                                    },
                                    device: {
                                      type: "string",
                                      enum: ["full", "desktop", "mobile"],
                                    },
                                  },
                                  required: ["continuationCode", "path", "device"],
                                },
                              },
                              required: ["url", "method", "fields"],
                            },
                          },
                          required: ["continuation"],
                        },
                      },
                      required: ["data"],
                    },
                  },
                },
              },
            },
            "x-scalius-agent": reviewedContinuation,
            "x-scalius-rbac": {
              type: "permission",
              permission: "settings.general.view",
            },
          },
        },
      },
    });

    expect(manifest[0]?.continuationOutput).toEqual(continuationOutput);
  });

  it.each([
    ["reviewed operation ID", "dashboard.theme.unreviewed"],
    ["continuation exposure", { exposure: "execute" }],
    ["continuation request transport", { transport: "json" }],
    ["forbidden batching", { batch: "sequential" }],
    ["sensitive output", { sensitiveOutput: false }],
    ["bounded output", { maximumResponseBytes: 8_193 }],
    ["exact URL pointer", { continuationOutput: { ...continuationOutput, urlJsonPointer: "/data/url" } }],
    ["exact fields pointer", { continuationOutput: { ...continuationOutput, fieldsJsonPointer: "/data/fields" } }],
    ["reviewed sensitive field", { continuationOutput: { ...continuationOutput, sensitiveFields: ["token"] } }],
  ] as const)("rejects secure continuation output without %s", (_label, override) => {
    const operationId = typeof override === "string"
      ? override
      : "dashboard.theme.preview_session_create";
    const metadata = typeof override === "string"
      ? reviewedContinuation
      : { ...reviewedContinuation, ...override };
    expect(() => parseAgentOperationMetadata(metadata, operationId)).toThrowError(
      /continuationOutput operation policy/,
    );
  });

  it("rejects malformed pointers, duplicate fields, extra policy keys, and untyped sensitive continuations", () => {
    for (const invalid of [
      { ...continuationOutput, urlJsonPointer: "data/continuation/url" },
      { ...continuationOutput, fieldsJsonPointer: "/data/~2fields" },
      { ...continuationOutput, sensitiveFields: ["continuationCode", "continuationCode"] },
      { ...continuationOutput, arbitraryHeaders: true },
    ]) {
      expect(() => parseAgentOperationMetadata(
        { ...reviewedContinuation, continuationOutput: invalid },
        "dashboard.theme.preview_session_create",
      )).toThrowError(/continuationOutput/);
    }

    const { continuationOutput: _continuationOutput, ...missingPolicy } =
      reviewedContinuation;
    expect(() => parseAgentOperationMetadata(
      missingPolicy,
      "dashboard.theme.preview_session_create",
    )).toThrowError(/requires reviewed x-scalius-agent.continuationOutput/);
  });

  it.each([
    ["unbounded URL", (schema: any) => { delete schema.properties.data.properties.continuation.properties.url.maxLength; }],
    ["non-canonical URL bound", (schema: any) => { schema.properties.data.properties.continuation.properties.url.maxLength = 511; }],
    ["non-URI URL", (schema: any) => { delete schema.properties.data.properties.continuation.properties.url.format; }],
    ["unbounded secret", (schema: any) => { delete schema.properties.data.properties.continuation.properties.fields.properties.continuationCode.maxLength; }],
    ["non-canonical secret grammar", (schema: any) => { schema.properties.data.properties.continuation.properties.fields.properties.continuationCode.pattern = "^tpc_.+$"; }],
    ["optional secret", (schema: any) => { schema.properties.data.properties.continuation.properties.fields.required = []; }],
    ["unbounded safe path", (schema: any) => { delete schema.properties.data.properties.continuation.properties.fields.properties.path.maxLength; }],
    ["widened device values", (schema: any) => { schema.properties.data.properties.continuation.properties.fields.properties.device.enum.push("tablet"); }],
    ["non-POST method", (schema: any) => { schema.properties.data.properties.continuation.properties.method.enum = ["GET"]; }],
  ])("rejects a continuation response schema with %s", (_label, mutate) => {
    const schema: any = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            continuation: {
              type: "object",
              properties: {
                url: { type: "string", format: "uri", maxLength: 512 },
                method: { type: "string", enum: ["POST"] },
                fields: {
                  type: "object",
                  properties: {
                    continuationCode: {
                      type: "string",
                      minLength: 52,
                      maxLength: 52,
                      pattern: "^tpc_[A-Za-z0-9_-]{48}$",
                    },
                    path: { type: "string", minLength: 1, maxLength: 512 },
                    device: {
                      type: "string",
                      enum: ["full", "desktop", "mobile"],
                    },
                  },
                  required: ["continuationCode", "path", "device"],
                },
              },
              required: ["url", "method", "fields"],
            },
          },
          required: ["continuation"],
        },
      },
      required: ["data"],
    };
    mutate(schema);
    expect(() => buildAgentOperationManifest({
      paths: {
        "/api/v1/admin/settings/theme/preview-session": {
          post: {
            operationId: "dashboard.theme.preview_session_create",
            responses: {
              200: { content: { "application/json": { schema } } },
            },
            "x-scalius-agent": reviewedContinuation,
            "x-scalius-rbac": {
              type: "permission",
              permission: "settings.general.view",
            },
          },
        },
      },
    })).toThrowError(/continuationOutput/);
  });
});
