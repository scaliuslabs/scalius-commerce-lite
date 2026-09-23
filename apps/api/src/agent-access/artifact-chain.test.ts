import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import type { AgentOAuthProps, AgentPrincipal } from "./types";

const chain = vi.hoisted(() => ({
  liveOperation: null as AgentOperationManifestEntry | null,
  props: null as AgentOAuthProps | null,
  principal: null as AgentPrincipal | null,
  getInventoryLabelVariants: vi.fn(),
  buildInventoryLabelArtifact: vi.fn(),
  getCurrencyConfig: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    ctx: ExecutionContext & { props: unknown };
    env: Env;
    constructor(ctx: ExecutionContext & { props: unknown }, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: vi.fn(),
  getMcpAuthContext: () => ({ props: chain.props }),
}));

vi.mock("@scalius/core/modules/inventory", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getInventoryLabelVariants: chain.getInventoryLabelVariants,
    buildInventoryLabelArtifact: chain.buildInventoryLabelArtifact,
  };
});

vi.mock("@scalius/core/modules/settings/settings.service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getCurrencyConfig: chain.getCurrencyConfig };
});

vi.mock("./principal", () => ({
  resolveAgentPrincipalFromBearer: vi.fn(async () => chain.principal),
  resolveAgentPrincipalFromGrant: vi.fn(async () => chain.principal),
}));

vi.mock("./backend", () => ({
  loadAgentAccessBackend: vi.fn(async () => ({
    resolvePrincipal: vi.fn(async () => chain.principal),
    authorizeOperation: vi.fn(async () => true),
    writeAudit: chain.writeAudit,
  })),
}));

vi.mock("./mcp/operations", () => ({
  getAuthorizedOperation: vi.fn(async (operationId: string, surface: string) => {
    const operation = chain.liveOperation;
    return operation?.operationId === operationId && operation.surface === surface
      ? operation
      : null;
  }),
  listAuthorizedOperations: vi.fn(async () => chain.liveOperation ? [chain.liveOperation] : []),
  summarizeOperation: vi.fn((operation: AgentOperationManifestEntry) => operation),
  describeOperation: vi.fn((operation: AgentOperationManifestEntry) => operation),
}));

import app from "../app";
import { finalizeOpenApiContract, type OpenApiDocument } from "../openapi-contract";
import { buildAgentOperationManifest } from "../openapi/agent-operation-manifest";
import { DashboardMcpHandler } from "./mcp/dashboard";
import { createAgentMcpServer } from "./mcp/server";

function liveLabelOperation(): AgentOperationManifestEntry {
  const document = finalizeOpenApiContract(app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Live artifact chain", version: "test" },
  })) as unknown as OpenApiDocument;
  const operation = buildAgentOperationManifest(document).find(
    (candidate) =>
      candidate.operationId === "dashboard.inventory_labels.generate_artifact",
  );
  if (!operation) throw new Error("Live label artifact operation is missing");
  return operation;
}

const GRANT_ID = "agr_0123456789abcdefghij";
const OWNER_ID = "b2de2a7d-d990-4456-b69e-27d55710938c";
const ARTIFACT_TEXT = "sku,barcode\nSKU-1,036000291452\n";
const ARTIFACT_BYTES = new TextEncoder().encode(ARTIFACT_TEXT);

function principal(): AgentPrincipal {
  return {
    kind: "agent",
    grantId: GRANT_ID,
    credentialId: null,
    ownerUserId: OWNER_ID,
    isSuperAdmin: true,
    resource: "dashboard",
    grantKind: "oauth",
    preset: "full",
    permissions: new Set(["products.view"]),
    riskCeiling: "security",
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 3600_000),
  };
}

function executionContext(props: AgentOAuthProps) {
  return {
    props,
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { props: AgentOAuthProps };
}

function labelInput() {
  return {
    format: "csv",
    mode: "job",
    variantIds: ["var_1"],
    quantities: { var_1: 1 },
    order: "selected",
    preset: {
      pageWidthMm: 210,
      pageHeightMm: 297,
      columns: 3,
      rows: 8,
      marginXmm: 8,
      marginYmm: 8,
      gapXmm: 2,
      gapYmm: 2,
      cropMarks: true,
    },
    startOffset: 0,
    alignment: { xMm: 0, yMm: 0 },
    content: {
      showProduct: true,
      showVariant: true,
      showSku: true,
      showPrice: true,
    },
  };
}

function inMemoryR2() {
  const objects = new Map<string, { bytes: ArrayBuffer }>();
  return {
    objects,
    binding: {
      put: vi.fn(async (
        key: string,
        value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string,
        options?: R2PutOptions,
      ) => {
        const bytes = value instanceof ReadableStream
          ? await new Response(value).arrayBuffer()
          : await new Response(value as BodyInit).arrayBuffer();
        void options;
        objects.set(key, { bytes });
        return { key };
      }),
      get: vi.fn(async (key: string) => {
        const object = objects.get(key);
        if (!object) return null;
        return {
          size: object.bytes.byteLength,
          arrayBuffer: async () => object.bytes.slice(0),
        };
      }),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
    } as unknown as R2Bucket,
  };
}

describe("continuous MCP artifact execution and one-use download", () => {
  let sqlite: DatabaseSync | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    chain.liveOperation = liveLabelOperation();
    chain.principal = principal();
    chain.props = {
      grantId: GRANT_ID,
      ownerUserId: OWNER_ID,
      resource: "dashboard",
      permissions: ["products.view"],
      riskCeiling: "security",
      audience: ["https://api.example.test/api/v1/mcp/dashboard"],
    };
    chain.getInventoryLabelVariants.mockResolvedValue({
      variants: [{
        id: "var_1",
        productName: "Product One",
        sku: "SKU-1",
        optionLabel: null,
        effectivePrice: 125,
        barcode: "036000291452",
        barcodeType: "upc",
      }],
      missingVariantIds: [],
    });
    chain.buildInventoryLabelArtifact.mockReturnValue({
      body: ARTIFACT_TEXT,
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
      copyCount: 1,
      pageCount: 1,
      byteLength: ARTIFACT_BYTES.byteLength,
    });
    chain.getCurrencyConfig.mockResolvedValue({ code: "BDT" });
    chain.writeAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("uses live manifest metadata, real Hono+D1 handle authority, R2 bytes, and denies replay", async () => {
    const liveOperation = chain.liveOperation;
    if (!liveOperation) throw new Error("Missing live label artifact operation");
    expect(liveOperation).toMatchObject({
      operationId: "dashboard.inventory_labels.generate_artifact",
      method: "POST",
      pathTemplate: "/api/v1/admin/inventory/labels/artifact",
      transport: "json",
      artifactOutput: {
        delivery: "authenticated-handle",
        disposition: "attachment",
        mediaTypes: expect.arrayContaining(["text/csv"]),
      },
      exposure: "execute",
    });

    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, 'Owner', 'owner@example.test')").run(OWNER_ID);
    sqlite.prepare(`
      INSERT INTO agent_grants (
        id, kind, owner_user_id, resource, label, oauth_client_id, oauth_redirect_uris_json, preset,
        permissions_json, risk_ceiling, authority_revision, status, expires_at, created_at, updated_at
      ) VALUES (?, 'oauth', ?, 'dashboard', 'Labels', 'client-1', '[]', 'full', '["products.view"]',
        'security', 1, 'active', ?, ?, ?)
    `).run(GRANT_ID, OWNER_ID, now + 3600, now - 1, now - 1);
    const r2 = inMemoryR2();
    const env = {
      DB: harness.binding,
      PUBLIC_API_BASE_URL: "https://api.example.test",
      STOREFRONT_URL: "https://storefront.example.test",
      SCALIUS_SECRET: "artifact-chain-test-master-secret-0123456789",
      AGENT_TOKEN_PEPPER: "test-pepper",
      RL_STANDARD: {
        limit: vi.fn(async () => ({ success: true })),
      },
      BUCKET: r2.binding,
    } as unknown as Env;
    const ctx = executionContext(chain.props!);

    // Exercise the registered operations.read callback, rather than calling
    // the artifact adapter directly. Only operation discovery is controlled so
    // this pre-freeze test can use the live finalized contract instead of the
    // intentionally stale checked-in generated snapshot.
    const server = createAgentMcpServer({ surface: "dashboard", env, ctx });
    const read = Reflect.get(server, "_registeredTools")?.["operations.read"]
      ?.handler as ((input: unknown) => Promise<Record<string, unknown>>) | undefined;
    expect(read).toBeTypeOf("function");
    const toolResult = await read!({
      operationId: liveOperation.operationId,
      input: { body: labelInput() },
    });
    expect(toolResult).not.toHaveProperty("isError");
    const content = toolResult.content as Array<Record<string, unknown>>;
    const link = content.find((item) => item.type === "resource_link");
    expect(link).toMatchObject({
      type: "resource_link",
      mimeType: "text/csv",
      uri: expect.stringMatching(
        /^https:\/\/api\.example\.test\/api\/v1\/mcp\/dashboard\/artifacts\/aah_[A-Za-z0-9_-]{20}$/,
      ),
    });
    expect(JSON.stringify(toolResult)).not.toContain("036000291452");
    expect(r2.objects.size).toBe(1);
    const [objectKey, object] = [...r2.objects][0]!;
    expect(objectKey).toMatch(/^private\/agent-artifacts\//);
    expect(new TextDecoder().decode(object.bytes)).not.toContain("036000291452");

    const handle = sqlite.prepare(`
      SELECT id, status, operation_id operationId, credential_id credentialId,
        size_bytes sizeBytes, sha256
      FROM agent_artifact_handles
    `).get() as Record<string, unknown>;
    expect(handle).toMatchObject({
      status: "active",
      operationId: liveOperation.operationId,
      credentialId: null,
      sizeBytes: ARTIFACT_BYTES.byteLength,
    });
    expect(handle.sha256).toMatch(/^[0-9a-f]{64}$/);

    const handler = new DashboardMcpHandler(ctx, env);
    const first = await handler.fetch(new Request(String(link?.uri), {
      headers: { Authorization: "Bearer provider-validated" },
    }));
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toContain("text/csv");
    expect(first.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="barcode-labels-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await first.text()).toBe(ARTIFACT_TEXT);
    // The one-use claim occurs before R2 read. After the response is safely
    // buffered, request cleanup removes both the object and terminal handle;
    // replay remains denied even when immediate cleanup succeeds.
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles").get())
      .toBeUndefined();
    expect(r2.objects.size).toBe(0);

    const replay = await handler.fetch(new Request(String(link?.uri), {
      headers: { Authorization: "Bearer provider-validated" },
    }));
    expect(replay.status).toBe(404);
    expect(await replay.text()).not.toContain(ARTIFACT_TEXT);
  });
});
