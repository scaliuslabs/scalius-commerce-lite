import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import type { AgentPrincipal } from "./types";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sha256: vi.fn(),
  getDb: vi.fn(() => ({ marker: "db" })),
  expire: vi.fn(),
  listCleanup: vi.fn(),
  deleteRecords: vi.fn(),
}));

vi.mock("@scalius/database/client", () => ({ getDb: mocks.getDb }));
vi.mock("./artifacts", () => ({
  createAgentArtifact: mocks.create,
  sha256Hex: mocks.sha256,
  expireAgentArtifactHandles: mocks.expire,
  listAgentArtifactCleanupCandidates: mocks.listCleanup,
  deleteAgentArtifactRecords: mocks.deleteRecords,
}));

import {
  AgentArtifactDeliveryError,
  parseArtifactFilename,
  purgeExpiredAgentArtifacts,
  stageAgentArtifact,
} from "./artifact-delivery";

const principal: AgentPrincipal = {
  kind: "agent",
  grantId: "agr_0123456789abcdefghij",
  credentialId: "agc_0123456789abcdefghij",
  ownerUserId: "b2de2a7d-d990-4456-b69e-27d55710938c",
  isSuperAdmin: true,
  resource: "dashboard",
  grantKind: "pat",
  preset: "full",
  permissions: new Set(["orders.view"]),
  riskCeiling: "security",
  authorityRevision: 1,
  expiresAt: new Date(Date.now() + 60_000),
};

function artifactOperation(
  overrides: Partial<AgentOperationManifestEntry> = {},
): AgentOperationManifestEntry {
  return {
    operationId: "dashboard.orders.export",
    method: "GET",
    pathTemplate: "/api/v1/admin/orders/export",
    summary: "Export orders",
    tags: ["Admin - Orders"],
    surface: "dashboard",
    exposure: "execute",
    principals: ["admin"],
    risk: "read",
    openWorld: false,
    idempotency: "none",
    revision: "none",
    batch: "forbidden",
    transport: "json",
    maxResponseBytes: 1024,
    maxRequestBytes: 1024 * 1024,
    sensitiveOutput: false,
    oneTimeSecretOutput: false,
    requiredClientAction: null,
    artifactOutput: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
    continuationOutput: null,
    rbac: { type: "permission", permission: "orders.view" },
    inputSchema: {},
    outputSchema: {},
    ...overrides,
  };
}

function artifactEnv(options: { createFails?: boolean; storageFails?: boolean } = {}) {
  const stored: ArrayBuffer[] = [];
  const deleted: string[] = [];
  const env = {
    PUBLIC_API_BASE_URL: "https://api.example.test",
    AGENT_ARTIFACTS: {
      put: vi.fn(async (_key: string, value: ReadableStream) => {
        if (options.storageFails) throw new Error("R2 unavailable");
        stored.push(await new Response(value).arrayBuffer());
        return {};
      }),
      delete: vi.fn(async (key: string) => { deleted.push(key); }),
    },
  } as unknown as Env;
  mocks.create.mockImplementationOnce(async () => {
    if (options.createFails) throw new Error("D1 unavailable");
    return {
      artifactId: "aah_0123456789abcdefghij",
      downloadUrl: "https://api.example.test/api/v1/agent-artifacts/aah_0123456789abcdefghij",
    };
  });
  return { env, stored, deleted };
}

describe("manifest-driven artifact delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sha256.mockResolvedValue("a".repeat(64));
    mocks.expire.mockResolvedValue(undefined);
    mocks.listCleanup.mockResolvedValue([]);
    mocks.deleteRecords.mockResolvedValue(0);
  });

  it("drains more than 900 rows sequentially while one poison object remains retryable", async () => {
    const expiresAt = new Date(Date.now() - 1_000);
    const remaining = new Map(Array.from({ length: 1_050 }, (_, index) => {
      const id = `aah_${String(index).padStart(20, "0")}`;
      return [id, { id, r2Key: `agent-artifacts/${id}`, expiresAt }];
    }));
    const poisonId = "aah_00000000000000000000";
    mocks.listCleanup.mockImplementation(async (
      _db: unknown,
      options: { limit: number; after?: { expiresAt: Date; id: string } },
    ) => [...remaining.values()]
      .filter((candidate) => !options.after || candidate.id > options.after.id)
      .slice(0, options.limit));
    mocks.deleteRecords.mockImplementation(async (_db: unknown, ids: string[]) => {
      for (const id of ids) remaining.delete(id);
      return ids.length;
    });
    let activeR2Deletes = 0;
    let maxActiveR2Deletes = 0;
    const deleteObject = vi.fn(async (key: string) => {
      activeR2Deletes += 1;
      maxActiveR2Deletes = Math.max(maxActiveR2Deletes, activeR2Deletes);
      try {
        if (key.endsWith(poisonId)) throw new Error("poison object unavailable");
      } finally {
        activeR2Deletes -= 1;
      }
    });
    await purgeExpiredAgentArtifacts({
      AGENT_ARTIFACTS: { delete: deleteObject },
    } as unknown as Env);

    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(maxActiveR2Deletes).toBe(1);
    expect(remaining.size).toBe(1);
    expect(remaining.has(poisonId)).toBe(true);
    expect(mocks.deleteRecords).toHaveBeenCalledTimes(21);
    expect(mocks.deleteRecords.mock.calls.every((call) => call[1].length <= 90)).toBe(true);
    expect(mocks.listCleanup.mock.calls.length).toBeGreaterThan(10);
    expect(mocks.listCleanup.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it.each([
    ["attachment", 'attachment; filename="orders.csv"', "orders.csv"],
    ["inline", 'inline; filename="invoice.html"', "invoice.html"],
    ["attachment", 'attachment; filename="labels.pdf"', "labels.pdf"],
  ] as const)("parses safe %s filenames", (disposition, header, filename) => {
    expect(parseArtifactFilename(header, disposition)).toBe(filename);
  });

  it("streams bytes into dedicated R2, persists only metadata, and returns an audience-child link", async () => {
    const { env, stored } = artifactEnv();
    const result = await stageAgentArtifact(
      artifactOperation(),
      new Response("order_id,total\nord_1,10\n", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="orders.csv"',
        },
      }),
      principal,
      env,
    );
    expect(new TextDecoder().decode(stored[0])).toContain("ord_1");
    expect(mocks.create).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        grantId: principal.grantId,
        operationId: "dashboard.orders.export",
        mediaType: "text/csv",
        filename: "orders.csv",
        sha256: "a".repeat(64),
      }),
      env,
    );
    expect(result.uri).toBe(
      "https://api.example.test/api/v1/mcp/dashboard/artifacts/aah_0123456789abcdefghij",
    );
    expect(JSON.stringify(result)).not.toContain("ord_1");
  });

  it("deletes the R2 object when relational handle creation fails", async () => {
    const { env, deleted } = artifactEnv({ createFails: true });
    const failure = stageAgentArtifact(
      artifactOperation(),
      new Response("csv", {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="orders.csv"',
        },
      }),
      principal,
      env,
    );
    await expect(failure).rejects.toMatchObject({
      code: "artifact_handle_failed",
      status: 502,
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain(`agent-artifacts/${principal.grantId}/`);
  });

  it("classifies dedicated R2 failures without exposing provider details", async () => {
    const { env, deleted } = artifactEnv({ storageFails: true });
    const failure = stageAgentArtifact(
      artifactOperation(),
      new Response("csv", {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="orders.csv"',
        },
      }),
      principal,
      env,
    );

    await expect(failure).rejects.toMatchObject({
      code: "artifact_storage_failed",
      status: 502,
    });
    await expect(failure).rejects.not.toThrow("R2 unavailable");
    expect(deleted).toHaveLength(1);
  });

  it("classifies synchronous stream failures without exposing runtime details", async () => {
    const { env } = artifactEnv();
    const response = new Response("csv", {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="orders.csv"',
      },
    });
    await response.text();

    await expect(stageAgentArtifact(
      artifactOperation(),
      response,
      principal,
      env,
    )).rejects.toMatchObject({
      code: "artifact_staging_failed",
      status: 502,
    });
  });

  it("fails before persistence on wrong media, unsafe filename, or overflow", async () => {
    const { env } = artifactEnv();
    await expect(stageAgentArtifact(
      artifactOperation(),
      new Response("html", {
        headers: {
          "Content-Type": "text/html",
          "Content-Disposition": 'attachment; filename="orders.csv"',
        },
      }),
      principal,
      env,
    )).rejects.toBeInstanceOf(AgentArtifactDeliveryError);
    expect(() => parseArtifactFilename(
      'attachment; filename="../token.csv"',
      "attachment",
    )).toThrow(AgentArtifactDeliveryError);
    await expect(stageAgentArtifact(
      artifactOperation({
        artifactOutput: {
          ...artifactOperation().artifactOutput!,
          maxArtifactBytes: 2,
        },
      }),
      new Response("too large", {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="orders.csv"',
        },
      }),
      principal,
      env,
    )).rejects.toBeInstanceOf(AgentArtifactDeliveryError);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
