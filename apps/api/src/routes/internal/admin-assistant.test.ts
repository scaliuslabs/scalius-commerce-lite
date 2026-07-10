import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import {
  ConflictError,
  UnauthorizedError,
} from "@scalius/core/errors";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createSession: vi.fn(),
  bindAgentInstance: vi.fn(),
  resumeSession: vi.fn(),
  revokeSession: vi.fn(),
  createWorkflow: vi.fn(),
  listEvents: vi.fn(),
  executeCommand: vi.fn(),
  consumeHandoff: vi.fn(),
  confirmHandoff: vi.fn(),
  beginHandoff: vi.fn(),
  failHandoff: vi.fn(),
  uncertainHandoff: vi.fn(),
  beginAdmission: vi.fn(),
  finishAdmission: vi.fn(),
  recordStop: vi.fn(),
  readStop: vi.fn(),
  finishStop: vi.fn(),
  resolveFlueAuthority: vi.fn(),
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
    bindAssistantAgentInstance: mocks.bindAgentInstance,
    resumeAssistantSession: mocks.resumeSession,
    revokeAssistantSession: mocks.revokeSession,
    createAssistantWorkflow: mocks.createWorkflow,
    listAssistantEvents: mocks.listEvents,
    consumeAssistantComputerHandoff: mocks.consumeHandoff,
    confirmAssistantComputerHandoffDispatch: mocks.confirmHandoff,
    beginAssistantComputerHandoffDispatch: mocks.beginHandoff,
    failAssistantComputerHandoffDispatch: mocks.failHandoff,
    markAssistantComputerHandoffDispatchUncertain: mocks.uncertainHandoff,
    beginAssistantAgentAdmission: mocks.beginAdmission,
    finishAssistantAgentAdmission: mocks.finishAdmission,
    recordAssistantComputerStopBarrier: mocks.recordStop,
    readAssistantComputerStopBarrier: mocks.readStop,
    finishAssistantComputerStopBarrier: mocks.finishStop,
  };
});

vi.mock("./flue-command-authority", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./flue-command-authority")
  >();
  return {
    ...actual,
    resolveAdminFlueCommandAuthority: mocks.resolveFlueAuthority,
  };
});

vi.mock("./flue-command-execution", () => ({
  executeAdminFlueCommand: mocks.executeCommand,
  failure: (code: string, message: string, retryable: boolean) => ({
    success: false,
    error: { code, message, retryable },
  }),
}));

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
const FUTURE = Date.parse("2030-07-10T08:00:00.000Z");
const FLUE_SIGNING_KEY = "admin-flue-thread-signing-key-at-least-32-bytes";
const FLUE_THREAD_ID = "conv_abcdefghijklmnopqrstuv";

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

function createTestApp(envOverrides: Partial<Env> = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "assistant-test-db" };
  const env = {
    STOREFRONT_URL: "https://storefront.test",
    PUBLIC_API_BASE_URL: "https://api.test",
    PROJECT_CACHE_PREFIX: "test-store",
    ASSISTANT_THREAD_SIGNING_KEY: FLUE_SIGNING_KEY,
    ...envOverrides,
  } as Env;

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
    mocks.executeCommand.mockResolvedValue({
      success: true,
      data: { command: "help", capabilities: [] },
    });
    mocks.resolveFlueAuthority.mockResolvedValue({
      session: { id: "as_session_1" },
      permissions: new Set([PERMISSIONS.PRODUCTS_VIEW]),
    });
    mocks.consumeHandoff.mockImplementation(async (_db, input) => ({
      status: "claimed",
      state: input.state,
      requestId: input.requestId,
      ...(input.state === "dispatched"
        ? { dispatchClaimToken: "d".repeat(43) }
        : {}),
    }));
    mocks.confirmHandoff.mockImplementation(async (_db, input) => ({
      status: "confirmed",
      state: "dispatched",
      requestId: input.requestId,
    }));
    mocks.beginHandoff.mockImplementation(async (_db, input) => ({
      status: "started",
      requestId: input.requestId,
    }));
    mocks.failHandoff.mockImplementation(async (_db, input) => ({
      status: "failed",
      state: "dispatched",
      requestId: input.requestId,
    }));
    mocks.uncertainHandoff.mockImplementation(async (_db, input) => ({
      status: "uncertain",
      state: "dispatched",
      requestId: input.requestId,
    }));
    mocks.beginAdmission.mockResolvedValue({
      status: "started",
      admissionId: "a".repeat(22),
      admissionClaimToken: "b".repeat(43),
    });
    mocks.finishAdmission.mockResolvedValue({ status: "finished" });
    mocks.recordStop.mockResolvedValue({
      status: "ready", stoppedThroughIssuedAtMs: Date.now(), blockedDispatches: 0,
      pendingDispatches: 0, pendingAdmissions: 0,
    });
    mocks.readStop.mockResolvedValue({
      status: "ready", stoppedThroughIssuedAtMs: Date.now(), blockedDispatches: 0,
      pendingDispatches: 0, pendingAdmissions: 0,
    });
    mocks.finishStop.mockResolvedValue({ status: "finished" });

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
        expiresAt: FUTURE,
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
    mocks.bindAgentInstance.mockImplementation(async () => {
      if (!currentSession) throw new Error("Missing test session");
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

  it("admits Flue commands by bound instance without dashboard-cookie middleware", async () => {
    const { app, db, env } = createTestApp();
    const response = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program: "help" },
      { "Content-Type": "application/json" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { command: "help", capabilities: [] },
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      env,
    }), {
      instanceId: `v1.${"i".repeat(43)}`,
      program: "help",
    });
    expect((mocks.executeCommand.mock.calls[0]?.[0] as { get(name: string): unknown })
      .get("db")).toBe(db);
  });

  it("rejects identity headers and malformed command bodies before command work", async () => {
    const { app, env } = createTestApp();
    const injected = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program: "help" },
      { "Content-Type": "application/json", "X-Scalius-Tenant-Id": "forged" },
    );
    expect(injected.status).toBe(400);
    await expect(injected.json()).resolves.toEqual({
      success: false,
      error: {
        code: "invalid_request",
        message: "Scalius request headers are invalid.",
        retryable: false,
      },
    });
    const cookieInjected = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program: "help" },
      { "Content-Type": "application/json", Cookie: "session=caller-controlled" },
    );
    expect(cookieInjected.status).toBe(400);
    await expect(cookieInjected.json()).resolves.toMatchObject({
      success: false,
      error: { code: "invalid_request", retryable: false },
    });
    const malformed = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: "guessed", program: "help", tenantId: "forged" },
      { "Content-Type": "application/json" },
    );
    expect(malformed.status).toBe(400);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("atomically consumes and confirms bound-instance handoffs without dashboard middleware", async () => {
    const { app, db, env } = createTestApp();
    const instanceId = `v1.${"i".repeat(43)}`;
    const requestId = "abcdefghijklmnopqrstuv";
    const programDigest = "p".repeat(43);
    const ticketExpiresAt = Date.now() + 120_000;
    const ticketIssuedAt = ticketExpiresAt - 120_000;
    const consumed = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffConsume,
      {
        instanceId,
        requestId,
        programDigest,
        state: "dispatched",
        ticketIssuedAt,
        ticketExpiresAt,
      },
      { "Content-Type": "application/json" },
    );
    expect(consumed.status).toBe(200);
    await expect(consumed.json()).resolves.toEqual({
      success: true,
      data: {
        status: "claimed",
        state: "dispatched",
        requestId,
        dispatchClaimToken: "d".repeat(43),
      },
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.resolveFlueAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ env }),
      instanceId,
    );
    expect(mocks.consumeHandoff).toHaveBeenCalledWith(db, {
      sessionId: "as_session_1",
      agentInstanceId: instanceId,
      requestId,
      programDigest,
      state: "dispatched",
      ticketIssuedAtMs: ticketIssuedAt,
      ticketExpiresAt,
    });

    const confirmed = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffConfirm,
      {
        instanceId,
        requestId,
        programDigest,
        dispatchClaimToken: "d".repeat(43),
      },
      { "Content-Type": "application/json" },
    );
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toEqual({
      success: true,
      data: { status: "confirmed", state: "dispatched", requestId },
    });
    expect(mocks.confirmHandoff).toHaveBeenCalledWith(db, {
      sessionId: "as_session_1",
      agentInstanceId: instanceId,
      requestId,
      programDigest,
      dispatchClaimToken: "d".repeat(43),
    });
  });

  it("fails handoff conflicts, uncertainty, injected identity, and malformed bodies closed", async () => {
    const { app, env } = createTestApp();
    const body = {
      instanceId: `v1.${"i".repeat(43)}`,
      requestId: "abcdefghijklmnopqrstuv",
      programDigest: "p".repeat(43),
      state: "cancelled",
      ticketIssuedAt: Date.now(),
      ticketExpiresAt: Date.now() + 120_000,
    };
    mocks.consumeHandoff.mockResolvedValueOnce({
      status: "conflict",
      state: "dispatched",
      requestId: body.requestId,
    });
    const conflict = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffConsume,
      body,
      { "Content-Type": "application/json" },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      success: false,
      error: { code: "handoff_terminal_conflict", retryable: false },
    });

    mocks.consumeHandoff.mockResolvedValueOnce({
      status: "uncertain",
      state: "dispatched",
      requestId: body.requestId,
    });
    const uncertain = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffConsume,
      { ...body, state: "dispatched" },
      { "Content-Type": "application/json" },
    );
    expect(uncertain.status).toBe(503);
    await expect(uncertain.json()).resolves.toMatchObject({
      error: { code: "handoff_dispatch_uncertain", retryable: false },
    });

    for (const [invalidBody, headers] of [
      [body, { "Content-Type": "application/json", Cookie: "forged=1" }],
      [body, { "Content-Type": "application/json", "X-Scalius-Thread-Id": "forged" }],
      [{ ...body, requestId: "short" }, { "Content-Type": "application/json" }],
    ] as const) {
      const invalid = await post(
        app,
        env,
        ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffConsume,
        invalidBody,
        headers,
      );
      expect(invalid.status).toBe(400);
    }
    expect(mocks.consumeHandoff).toHaveBeenCalledTimes(2);
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

  it("admits and idempotently replays one API-owned opaque Admin Flue thread", async () => {
    const { app, db, env } = createTestApp();
    const headers = authHeaders({ credential: null });
    const [first, replay] = await Promise.all([
      post(
        app,
        env,
        ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        { threadId: FLUE_THREAD_ID },
        headers,
      ),
      post(
        app,
        env,
        ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        { threadId: FLUE_THREAD_ID },
        headers,
      ),
    ]);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    const firstCreate = mocks.createSession.mock.calls[0]![1];
    const replayCreate = mocks.createSession.mock.calls[1]![1];
    expect(firstCreate).toMatchObject({
      surface: "admin",
      actorType: "admin",
      actorId: "admin_1",
      conversationKey: FLUE_THREAD_ID,
      credential: expect.stringMatching(/^session_asst_[A-Za-z0-9_-]{43}$/u),
      permissionSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      safeMetadata: {
        schemaVersion: 1,
        dashboardSessionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      ttlSeconds: 28_800,
    });
    expect(firstCreate.credential).toBe(replayCreate.credential);
    expect(firstCreate.credential).not.toContain(FLUE_SIGNING_KEY);

    const firstBody = await first.json() as {
      data: { agent: Record<string, unknown> };
    };
    const replayBody = await replay.json() as {
      data: { agent: Record<string, unknown> };
    };
    expect(Object.keys(firstBody.data.agent).sort()).toEqual([
      "expiresAt",
      "instanceId",
      "principalId",
      "surface",
      "tenantId",
      "threadId",
    ]);
    expect(firstBody.data.agent).toEqual({
      surface: "admin",
      instanceId: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
      tenantId: expect.stringMatching(/^tenant_[A-Za-z0-9_-]{43}$/u),
      principalId: expect.stringMatching(/^principal_[A-Za-z0-9_-]{43}$/u),
      threadId: FLUE_THREAD_ID,
      expiresAt: FUTURE,
    });
    expect(replayBody.data.agent).toEqual(firstBody.data.agent);
    expect(mocks.bindAgentInstance).toHaveBeenNthCalledWith(1, db, {
      sessionId: "as_session_1",
      agentInstanceId: firstBody.data.agent.instanceId,
    });
    const responseCanary = JSON.stringify(firstBody);
    expect(responseCanary).not.toMatch(
      /admin_1|dashboard_session_1|permissionSnapshotHash|credential|safeMetadata/,
    );
    expect(responseCanary).not.toContain(FLUE_SIGNING_KEY);
  });

  it("fails Admin admission closed on identity drift, binding conflict, and expiry", async () => {
    const { app, env } = createTestApp();
    const headers = authHeaders({ credential: null });
    const admitted = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: FLUE_THREAD_ID },
      headers,
    );
    expect(admitted.status).toBe(200);
    const originalCredential = mocks.createSession.mock.calls[0]![1].credential;

    mocks.createSession.mockImplementationOnce(async (_db, input) => {
      expect(input.credential).not.toBe(originalCredential);
      throw new ConflictError("Assistant session authority changed.");
    });
    const dashboardDrift = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: FLUE_THREAD_ID },
      authHeaders({ credential: null, dashboardSessionId: "dashboard_session_2" }),
    );
    expect(dashboardDrift.status).toBe(409);

    mocks.bindAgentInstance.mockRejectedValueOnce(
      new ConflictError("Assistant session agent binding changed."),
    );
    const conflict = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: "conv_abcdefghijklmnopqrstuw" },
      headers,
    );
    expect(conflict.status).toBe(409);

    mocks.bindAgentInstance.mockImplementationOnce(async () => ({
      ...currentSession!,
      expiresAt: Date.now() - 1,
    }));
    const expired = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: "conv_abcdefghijklmnopqrstux" },
      headers,
    );
    expect(expired.status).toBe(401);
  });

  it("rejects malformed, injected, public, and unconfigured Admin Flue admission", async () => {
    const { app, env } = createTestApp();
    const headers = authHeaders({ credential: null });
    for (const body of [
      { threadId: "thread_not_conv" },
      { threadId: FLUE_THREAD_ID, actorId: "admin_2" },
      { threadId: `conv_${"a".repeat(65)}` },
      { threadId: FLUE_THREAD_ID, padding: "x".repeat(17_000) },
    ]) {
      const response = await post(
        app,
        env,
        ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        body,
        headers,
      );
      expect(response.status).toBe(400);
    }
    const injected = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: FLUE_THREAD_ID },
      { ...headers, "X-Scalius-Tenant-Id": "forged" },
    );
    expect(injected.status).toBe(400);

    const publicResponse = await post(
      app,
      env,
      ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: FLUE_THREAD_ID },
      headers,
      "https://api.test",
    );
    expect(publicResponse.status).toBe(404);

    for (const envOverrides of [
      { ASSISTANT_THREAD_SIGNING_KEY: undefined as never },
      { ASSISTANT_THREAD_SIGNING_KEY: "too-short" },
      {
        ASSISTANT_THREAD_SIGNING_KEY: FLUE_SIGNING_KEY,
        ASSISTANT_RATE_LIMIT_HMAC_KEY: FLUE_SIGNING_KEY,
      },
    ]) {
      const configured = createTestApp(envOverrides);
      const response = await post(
        configured.app,
        configured.env,
        ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        { threadId: FLUE_THREAD_ID },
        headers,
      );
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toContain("Assistant thread admission is unavailable.");
      expect(text).not.toContain(FLUE_SIGNING_KEY);
    }
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
