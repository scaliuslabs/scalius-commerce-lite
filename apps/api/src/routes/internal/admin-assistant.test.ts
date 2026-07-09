import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import {
  UnauthorizedError,
} from "@scalius/core/errors";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  revokeSession: vi.fn(),
  createWorkflow: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock("../../middleware/admin-auth", () => ({
  adminAuthMiddleware: (
    c: unknown,
    next: () => Promise<void>,
  ) => mocks.authenticate(c, next),
}));

vi.mock("@scalius/core/modules/assistant", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@scalius/core/modules/assistant")
  >();
  return {
    ...actual,
    createAssistantSession: mocks.createSession,
    resumeAssistantSession: mocks.resumeSession,
    revokeAssistantSession: mocks.revokeSession,
    createAssistantWorkflow: mocks.createWorkflow,
    listAssistantEvents: mocks.listEvents,
  };
});

import {
  ADMIN_ASSISTANT_AUTHORITY_BASE_PATH,
  ADMIN_ASSISTANT_AUTHORITY_PATHS,
  ADMIN_ASSISTANT_SESSION_CREDENTIAL_HEADER,
  isExactInternalAdminAssistantRequest,
} from "./admin-assistant-contract";
import { adminAssistantAuthorityRoutes } from "./admin-assistant";

const CREDENTIAL = `session_asst_${"A".repeat(43)}`;
const OTHER_CREDENTIAL = `session_asst_${"B".repeat(43)}`;
const NOW = Date.parse("2026-07-10T00:00:00.000Z");

interface TestSession {
  id: string;
  surface: "admin" | "storefront";
  actorType: "admin" | "guest";
  actorId: string | null;
  conversationKey: string;
  status: "active" | "revoked" | "expired";
  permissionSnapshotHash: string | null;
  safeMetadata: unknown;
  lastEventSequence: number;
  expiresAt: number;
  lastSeenAt: number;
}

let currentSession: TestSession | null;

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "assistant-test-db" };
  const env = {} as Env;

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/internal/admin-assistant", adminAssistantAuthorityRoutes);
  return { app, db, env };
}

function authHeaders(overrides: {
  actorId?: string;
  dashboardSessionId?: string;
  permissions?: string[];
  credential?: string | null;
} = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Test-Authenticated": "true",
    "X-Test-Actor": overrides.actorId ?? "admin_1",
    "X-Test-Dashboard-Session":
      overrides.dashboardSessionId ?? "dashboard_session_1",
    "X-Test-Permissions": (overrides.permissions ?? [PERMISSIONS.PRODUCTS_VIEW])
      .join(","),
  };
  if (overrides.credential !== null) {
    headers[ADMIN_ASSISTANT_SESSION_CREDENTIAL_HEADER] =
      overrides.credential ?? CREDENTIAL;
  }
  return headers;
}

async function post(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  path: string,
  body: unknown,
  headers = authHeaders(),
  origin = "http://api.internal",
) {
  return app.request(`${origin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, env);
}

async function createBoundSession(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  headers = authHeaders(),
) {
  const response = await post(
    app,
    env,
    ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
    { conversationKey: "conversation_1" },
    headers,
  );
  expect(response.status).toBe(200);
  expect(currentSession).not.toBeNull();
  return currentSession!;
}

describe("internal Admin assistant authority boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = null;

    mocks.authenticate.mockImplementation(async (
      c: {
        req: { header(name: string): string | undefined };
        set(name: string, value: unknown): void;
        json(body: unknown, status: number): Response;
      },
      next: () => Promise<void>,
    ) => {
      if (c.req.header("X-Test-Authenticated") !== "true") {
        return c.json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        }, 401);
      }
      c.set("user", {
        id: c.req.header("X-Test-Actor") ?? "admin_1",
        name: "Admin",
        email: "redacted@example.invalid",
      });
      c.set("session", {
        id: c.req.header("X-Test-Dashboard-Session") ?? "dashboard_session_1",
        twoFactorVerified: true,
      });
      c.set("adminPermissions", new Set(
        (c.req.header("X-Test-Permissions") ?? "")
          .split(",")
          .filter(Boolean),
      ));
      await next();
    });

    mocks.createSession.mockImplementation(async (
      _db: unknown,
      input: {
        surface: "admin";
        actorType: "admin";
        actorId: string;
        conversationKey: string;
        credential: string;
        permissionSnapshotHash: string;
        safeMetadata: unknown;
      },
    ) => {
      currentSession = {
        id: "as_session_1",
        surface: input.surface,
        actorType: input.actorType,
        actorId: input.actorId,
        conversationKey: input.conversationKey,
        status: "active",
        permissionSnapshotHash: input.permissionSnapshotHash,
        safeMetadata: input.safeMetadata,
        lastEventSequence: 0,
        expiresAt: NOW + 8 * 60 * 60 * 1_000,
        lastSeenAt: NOW,
      };
      return {
        session: currentSession,
        credential: input.credential,
        replayed: false,
      };
    });
    mocks.resumeSession.mockImplementation(async (
      _db: unknown,
      input: { credential: string; expectedSurface: "admin" },
    ) => {
      if (
        input.credential !== CREDENTIAL ||
        !currentSession ||
        currentSession.status !== "active"
      ) {
        throw new UnauthorizedError("Assistant session unavailable.");
      }
      return currentSession;
    });
    mocks.revokeSession.mockImplementation(async () => {
      if (!currentSession) throw new Error("Missing test session");
      currentSession = { ...currentSession, status: "revoked" };
      return { session: currentSession, changed: true };
    });
    mocks.createWorkflow.mockImplementation(async (
      _db: unknown,
      input: {
        sessionId: string;
        clientRequestId: string;
        intent: string;
        riskClass: "read_only" | "reversible" | "consequential" | "high_risk";
        safePlan: Array<{ type: "text"; text: string }>;
      },
    ) => ({
      workflow: {
        id: "aw_workflow_1",
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        intent: input.intent,
        status: "queued",
        riskClass: input.riskClass,
        currentStep: 0,
        permissionSnapshotHash: currentSession?.permissionSnapshotHash ?? null,
        safePlan: input.safePlan,
        createdAt: NOW,
        updatedAt: NOW,
      },
      replayed: false,
    }));
    mocks.listEvents.mockImplementation(async (
      _db: unknown,
      input: { afterSequence: number; limit: number },
    ) => ({
      session: currentSession,
      events: [{
        eventId: "aev_1",
        sessionId: currentSession?.id,
        workflowId: null,
        actionId: null,
        sequence: input.afterSequence + 1,
        type: "workflow.progress",
        status: null,
        occurredAt: NOW,
        parts: [{ type: "text", text: "Safe progress." }],
      }],
      cursor: {
        afterSequence: input.afterSequence,
        nextSequence: input.afterSequence + 1,
        latestSequence: input.afterSequence + 1,
        hasMore: false,
      },
    }));
  });

  it("recognizes only the exact service-binding URL contract", () => {
    expect(isExactInternalAdminAssistantRequest(new Request(
      `http://api.internal${ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
      { method: "POST" },
    ))).toBe(true);
    for (const request of [
      new Request(
        `https://api.internal${ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
        { method: "POST" },
      ),
      new Request(
        `http://public.example${ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
        { method: "POST" },
      ),
      new Request(
        `http://api.internal${ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate}?credential=no`,
        { method: "POST" },
      ),
      new Request(
        `http://api.internal${ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
        { method: "GET" },
      ),
    ]) {
      expect(isExactInternalAdminAssistantRequest(request)).toBe(false);
    }
  });

  it("returns a bland no-store 404 before auth or body work on public hosts", async () => {
    const { app, env } = createTestApp();
    const response = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { actorId: "untrusted", credential: "untrusted" },
      { "Content-Type": "application/json" },
      "https://api.public.example",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: false,
      error: "not_found",
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("requires the existing authenticated dashboard middleware", async () => {
    const { app, env } = createTestApp();
    const response = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationKey: "conversation_1" },
      {
        "Content-Type": "application/json",
        [ADMIN_ASSISTANT_SESSION_CREDENTIAL_HEADER]: CREDENTIAL,
      },
    );

    expect(response.status).toBe(401);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("derives session ownership and policy snapshot server-side without echoing credentials", async () => {
    const { app, db, env } = createTestApp();
    const response = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationKey: "conversation_1" },
    );

    expect(response.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith(db, expect.objectContaining({
      surface: "admin",
      actorType: "admin",
      actorId: "admin_1",
      conversationKey: "conversation_1",
      credential: CREDENTIAL,
      permissionSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      safeMetadata: {
        schemaVersion: 1,
        dashboardSessionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      ttlSeconds: 28_800,
    }));
    const text = await response.text();
    expect(text).not.toContain(CREDENTIAL);
    expect(text).not.toContain("actorId");
    expect(text).not.toContain("safeMetadata");
    expect(text).not.toContain("permissionSnapshotHash");

    const untrusted = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      {
        conversationKey: "conversation_2",
        actorId: "admin_2",
        permissionSnapshotHash: "a".repeat(64),
      },
    );
    expect(untrusted.status).toBe(400);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("requires an exact strong credential in a header", async () => {
    const { app, env } = createTestApp();
    for (const credential of [null, "session_asst_short", OTHER_CREDENTIAL.slice(0, -1)]) {
      const response = await post(
        app,
        env,
        ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
        { conversationKey: "conversation_1" },
        authHeaders({ credential }),
      );
      expect(response.status).toBe(401);
    }
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("fails resume closed across actor, surface, dashboard-session, permission, and credential drift", async () => {
    const { app, env } = createTestApp();
    await createBoundSession(app, env);

    const success = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionResume,
      {},
    );
    expect(success.status).toBe(200);

    const crossActor = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionResume,
      {},
      authHeaders({ actorId: "admin_2" }),
    );
    expect(crossActor.status).toBe(401);

    currentSession = { ...currentSession!, surface: "storefront", actorType: "guest" };
    const crossSurface = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionResume,
      {},
    );
    expect(crossSurface.status).toBe(401);

    await createBoundSession(app, env);
    const crossDashboardSession = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionResume,
      {},
      authHeaders({ dashboardSessionId: "dashboard_session_2" }),
    );
    expect(crossDashboardSession.status).toBe(401);

    const rbacDrift = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionResume,
      {},
      authHeaders({ permissions: [PERMISSIONS.ORDERS_VIEW] }),
    );
    expect(rbacDrift.status).toBe(403);

    const wrongCredential = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionResume,
      {},
      authHeaders({ credential: OTHER_CREDENTIAL }),
    );
    expect(wrongCredential.status).toBe(401);

    currentSession = { ...currentSession!, status: "revoked" };
    const revoked = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionResume,
      {},
    );
    expect(revoked.status).toBe(401);
  });

  it("revokes only the credential-authorized current session", async () => {
    const { app, env } = createTestApp();
    const session = await createBoundSession(app, env);
    const response = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.sessionRevoke,
      {},
    );

    expect(response.status).toBe(200);
    expect(mocks.revokeSession).toHaveBeenCalledWith(
      expect.anything(),
      { sessionId: session.id },
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { changed: true, session: { status: "revoked" } },
    });
  });

  it("creates planning-only workflows from authorized registry facts", async () => {
    const { app, env } = createTestApp();
    await createBoundSession(app, env);
    const response = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.workflowCreate,
      {
        clientRequestId: "workflow_request_1",
        capabilityId: "admin.api.get.products",
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.createWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "as_session_1",
        clientRequestId: "workflow_request_1",
        intent: "admin.api.get.products",
        riskClass: "read_only",
        permissionSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        safePlan: [{
          type: "text",
          text: expect.stringMatching(/execution is unavailable/i),
        }],
      }),
    );

    const unauthorized = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.workflowCreate,
      {
        clientRequestId: "workflow_request_2",
        capabilityId: "admin.api.get.orders",
      },
    );
    expect(unauthorized.status).toBe(404);
    expect(mocks.createWorkflow).toHaveBeenCalledTimes(1);

    const missingExecute = await post(
      app,
      env,
      `${ADMIN_ASSISTANT_AUTHORITY_BASE_PATH}/execute`,
      {},
    );
    expect(missingExecute.status).toBe(404);
    expect(mocks.authenticate).toHaveBeenCalledTimes(3);
  });

  it("filters and compacts capability search/describe by current effective permissions", async () => {
    const { app, env } = createTestApp();
    await createBoundSession(app, env);
    const search = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.capabilitiesSearch,
      { query: "products", limit: 50 },
    );
    expect(search.status).toBe(200);
    const searchBody = await search.json() as {
      data: { capabilities: Array<Record<string, unknown>> };
    };
    expect(searchBody.data.capabilities.length).toBeGreaterThan(0);
    expect(searchBody.data.capabilities).toContainEqual(expect.objectContaining({
      id: "admin.api.get.products",
      execution: expect.objectContaining({
        enabled: false,
        readiness: "read-only-eligible",
      }),
      idempotency: { policy: "not-applicable", proven: true },
    }));
    for (const capability of searchBody.data.capabilities) {
      expect(capability).not.toHaveProperty("authorization");
      expect(JSON.stringify(capability)).not.toMatch(/evidenceId|adapterName/);
    }

    const describe = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.capabilitiesDescribe,
      { capabilityId: "admin.api.get.products" },
    );
    expect(describe.status).toBe(200);
    const unauthorized = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.capabilitiesDescribe,
      { capabilityId: "admin.api.get.orders" },
    );
    expect(unauthorized.status).toBe(404);

    const overLimit = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.capabilitiesSearch,
      { limit: 51 },
    );
    expect(overLimit.status).toBe(400);
  });

  it("lists monotonic events with bounded credential-bound cursor inputs", async () => {
    const { app, env } = createTestApp();
    const session = await createBoundSession(app, env);
    const response = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.eventsList,
      { afterSequence: 41, limit: 10 },
    );

    expect(response.status).toBe(200);
    expect(mocks.listEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        credential: CREDENTIAL,
        expectedSurface: "admin",
        expectedSessionId: session.id,
        expectedActorId: "admin_1",
        expectedConversationKey: "conversation_1",
        expectedPermissionSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        afterSequence: 41,
        limit: 10,
      }),
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        cursor: {
          afterSequence: 41,
          nextSequence: 42,
          hasMore: false,
        },
      },
    });

    for (const body of [
      { afterSequence: -1, limit: 10 },
      { afterSequence: 0, limit: 26 },
      { afterSequence: 0, limit: 10, credential: CREDENTIAL },
    ]) {
      const invalid = await post(
        app,
        env,
        ADMIN_ASSISTANT_AUTHORITY_PATHS.eventsList,
        body,
      );
      expect(invalid.status).toBe(400);
    }
    expect(mocks.listEvents).toHaveBeenCalledTimes(1);
  });

  it("keeps every authority path in the allow-any-admin route gate before exact capability checks", () => {
    for (const path of Object.values(ADMIN_ASSISTANT_AUTHORITY_PATHS)) {
      expect(getRoutePermission(path, "POST")).toEqual({ allowAnyAdmin: true });
    }
  });
});
