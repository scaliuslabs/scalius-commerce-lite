import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { AgentPrincipal } from "../agent-access/types";
import { createAgentArtifact, sealAgentArtifact } from "../agent-access/artifacts";

const mocks = vi.hoisted(() => ({
  resolveBearer: vi.fn(),
  resolveGrant: vi.fn(),
  authorizeOperation: vi.fn(),
  resolveOperation: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("../agent-access/principal", () => ({
  resolveAgentPrincipalFromBearer: mocks.resolveBearer,
  resolveAgentPrincipalFromGrant: mocks.resolveGrant,
}));

vi.mock("../agent-access/backend", () => ({
  loadAgentAccessBackend: async () => ({ authorizeOperation: mocks.authorizeOperation }),
}));

vi.mock("../agent-access/direct-operation", () => ({
  resolveAgentOperationById: mocks.resolveOperation,
}));

vi.mock("../agent-access/audit", () => ({
  writeAgentAuditEvent: mocks.writeAudit,
}));

import { agentArtifactRoutes } from "./agent-artifacts";

function createHarness() {
  const { sqlite, db } = createSqliteD1Database();
  const now = Math.floor(Date.now() / 1000);
  sqlite.exec("INSERT INTO user (id, name, email) VALUES ('owner-1', 'Owner', 'owner@example.test')");
  sqlite.prepare(`
    INSERT INTO agent_grants (
      id, kind, owner_user_id, resource, label, preset, permissions_json,
      risk_ceiling, authority_revision, status, expires_at, created_at, updated_at
    ) VALUES (?, 'pat', 'owner-1', 'dashboard', 'Agent', 'read', '["orders.view"]',
      'read', 1, 'active', ?, ?, ?)
  `).run(GRANT_ID, now + 3600, now - 10, now - 10);
  sqlite.prepare(`
    INSERT INTO agent_credentials (
      id, grant_id, kind, token_hash, token_hint, expires_at, revoked_at, created_at, updated_at
    ) VALUES (?, ?, 'pat', ?, 'sc_pat_...cdefghij', ?, NULL, ?, ?)
  `).run(CREDENTIAL_ID, GRANT_ID, "a".repeat(64), now + 3600, now - 10, now - 10);
  return { sqlite, db };
}

const GRANT_ID = "agr_0123456789abcdefghij";
const CREDENTIAL_ID = "agc_0123456789abcdefghij";
const TOKEN = `sc_pat_${CREDENTIAL_ID}_${"a".repeat(43)}`;
const BYTES = new TextEncoder().encode("abc").buffer as ArrayBuffer;
const SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function principal(permissions = new Set(["orders.view"])): AgentPrincipal {
  return {
    kind: "agent",
    grantId: GRANT_ID,
    credentialId: CREDENTIAL_ID,
    ownerUserId: "owner-1",
    isSuperAdmin: true,
    resource: "dashboard",
    grantKind: "pat",
    preset: "read",
    permissions,
    riskCeiling: "read",
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 3600_000),
  };
}

function operation() {
  return {
    operationId: "dashboard.orders.export",
    surface: "dashboard",
    exposure: "execute",
    principals: ["admin"],
    risk: "read",
    artifactOutput: {
      delivery: "authenticated-handle",
      mediaTypes: ["text/csv"],
      maxArtifactBytes: 16_777_216,
    },
  };
}

async function createArtifact(db: Database, suffix = "one") {
  return createAgentArtifact(db, {
    grantId: GRANT_ID,
    credentialId: CREDENTIAL_ID,
    resource: "dashboard",
    operationId: "dashboard.orders.export",
    mediaType: "text/csv",
    filename: "orders.csv",
    sizeBytes: 3,
    sha256: SHA256,
    r2Key: `private/agent-artifacts/${suffix}`,
  }, { PUBLIC_API_BASE_URL: "https://api.example.com" } as Env);
}

function appFor(db: Database) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/agent-artifacts", agentArtifactRoutes);
  app.onError((error) => {
    const status = (error as Error & { status?: unknown }).status;
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Request failed",
    }), {
      status: typeof status === "number" ? status : 500,
      headers: { "Content-Type": "application/json" },
    });
  });
  return app;
}

function envFor(input: {
  bytes?: ArrayBuffer | null;
  unsealed?: boolean;
  rateAllowed?: boolean;
  deleteFails?: boolean;
} = {}): Env {
  const bytes = input.bytes === undefined ? BYTES : input.bytes;
  const env: Env = {
    SCALIUS_SECRET: "artifact-route-test-master-secret-0123456789",
    AGENT_TOKEN_PEPPER: "pepper",
    RL_STANDARD: {
      limit: vi.fn().mockResolvedValue({ success: input.rateAllowed ?? true }),
    },
    BUCKET: {
      get: vi.fn(async (key: string) => {
        if (bytes === null) return null;
        const stored = input.unsealed ? bytes : (await sealAgentArtifact(env, key, bytes)).slice().buffer;
        return { size: stored.byteLength, arrayBuffer: async () => stored };
      }),
      delete: vi.fn(async () => {
        if (input.deleteFails) throw new Error("R2 unavailable");
      }),
    },
  } as unknown as Env;
  return env;
}

function download(app: ReturnType<typeof appFor>, env: Env, artifactId: string, headers: HeadersInit = {}) {
  return app.request(`/agent-artifacts/${artifactId}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
  }, env);
}

describe("authenticated agent artifact route", () => {
  let sqlite: DatabaseSync | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBearer.mockResolvedValue(principal());
    mocks.resolveGrant.mockResolvedValue(principal());
    mocks.resolveOperation.mockReturnValue(operation());
    mocks.authorizeOperation.mockImplementation(async (resolved: AgentPrincipal) =>
      resolved.permissions.has("orders.view"),
    );
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("returns verified bytes once with private attachment headers and a body-free audit", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    const response = await download(appFor(harness.db), envFor(), artifact.artifactId);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="orders.csv"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationId: "system.agent_artifacts.download",
      resourceIds: [artifact.artifactId],
      outcome: "success",
    }));
    const auditInput = mocks.writeAudit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditInput).not.toHaveProperty("body");
    expect(auditInput).not.toHaveProperty("bytes");
    expect(auditInput).not.toHaveProperty("filename");
    expect(auditInput).not.toHaveProperty("sha256");
    expect(sqlite.prepare("SELECT count(*) count FROM agent_artifact_handles").get()).toEqual({ count: 0 });
  });

  it("has one HTTP winner under concurrent replay", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    const app = appFor(harness.db);
    const env = envFor();
    const responses = await Promise.all([
      download(app, env, artifact.artifactId),
      download(app, env, artifact.artifactId),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
  });

  it("returns verified bytes while retaining a consumed row when immediate R2 cleanup fails", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    const response = await download(
      appFor(harness.db),
      envFor({ deleteFails: true }),
      artifact.artifactId,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles WHERE id = ?").get(
      artifact.artifactId,
    )).toEqual({ status: "consumed" });
  });

  it("returns intact bytes before deferred waitUntil cleanup removes R2 then D1", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const cleanupOrder: string[] = [];
    const env = envFor();
    const bucket = env.BUCKET as unknown as {
      delete: ReturnType<typeof vi.fn>;
    };
    bucket.delete.mockImplementation(async () => {
      cleanupOrder.push("r2-start");
      await deleteGate;
      cleanupOrder.push("r2-complete");
    });
    const captured: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => captured.push(promise)),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const response = await appFor(harness.db).request(
      `/agent-artifacts/${artifact.artifactId}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
      executionCtx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
    expect(executionCtx.waitUntil).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(1);
    expect(cleanupOrder).toEqual(["r2-start"]);
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles WHERE id = ?").get(
      artifact.artifactId,
    )).toEqual({ status: "consumed" });

    releaseDelete();
    await captured[0];
    cleanupOrder.push("d1-confirmed");
    expect(cleanupOrder).toEqual(["r2-start", "r2-complete", "d1-confirmed"]);
    expect(sqlite.prepare("SELECT count(*) count FROM agent_artifact_handles WHERE id = ?").get(
      artifact.artifactId,
    )).toEqual({ count: 0 });
  });

  it.each([
    ["missing R2 object", null, "r2_missing"],
    ["size mismatch", new TextEncoder().encode("abcd").buffer as ArrayBuffer, "size_mismatch"],
    ["digest mismatch", new TextEncoder().encode("abd").buffer as ArrayBuffer, "digest_mismatch"],
    ["unsealed object", BYTES, "digest_mismatch", true],
  ])("keeps a claimed artifact terminal after %s", async (_label, bytes, failureClass, unsealed = false) => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    const response = await download(appFor(harness.db), envFor({ bytes, unsealed }), artifact.artifactId);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("abc");
    expect(sqlite.prepare(`
      SELECT status, failure_class failureClass FROM agent_artifact_handles WHERE id = ?
    `).get(artifact.artifactId)).toEqual({ status: "failed", failureClass });
  });

  it("fails rate limiting before the one-use claim", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    const response = await download(appFor(harness.db), envFor({ rateAllowed: false }), artifact.artifactId);
    expect(response.status).toBe(429);
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles WHERE id = ?").get(
      artifact.artifactId,
    )).toEqual({ status: "active" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationId: "system.agent_artifacts.download",
      outcome: "denied",
      httpStatus: 429,
    }));
  });

  it("denies narrowed or revoked authority before the claim", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    mocks.resolveBearer.mockResolvedValue(principal(new Set()));
    const narrowed = await download(appFor(harness.db), envFor(), artifact.artifactId);
    expect(narrowed.status).toBe(403);
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationId: "system.agent_artifacts.download",
      outcome: "denied",
      errorClass: "ArtifactSourceOperationDenied",
      resourceIds: [artifact.artifactId],
    }));
    mocks.resolveBearer.mockResolvedValue(null);
    const revoked = await download(appFor(harness.db), envFor(), artifact.artifactId);
    expect(revoked.status).toBe(401);
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles WHERE id = ?").get(
      artifact.artifactId,
    )).toEqual({ status: "active" });
  });

  it("rejects cookies and system JWTs without consuming the handle", async () => {
    const harness = createHarness();
    sqlite = harness.sqlite;
    const artifact = await createArtifact(harness.db);
    const app = appFor(harness.db);
    const mixed = await download(app, envFor(), artifact.artifactId, { Cookie: "session=ambiguous" });
    expect(mixed.status).toBe(403);
    const system = await app.request(`/agent-artifacts/${artifact.artifactId}`, {
      headers: { Authorization: "Bearer system.jwt.value" },
    }, envFor());
    expect(system.status).toBe(401);
    expect(sqlite.prepare("SELECT status FROM agent_artifact_handles WHERE id = ?").get(
      artifact.artifactId,
    )).toEqual({ status: "active" });
  });
});
