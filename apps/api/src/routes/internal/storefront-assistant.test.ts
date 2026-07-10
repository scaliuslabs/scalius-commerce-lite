import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  RateLimitError,
  UnauthorizedError,
} from "@scalius/core/errors";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  bindAgentInstance: vi.fn(),
  consumeRateLimit: vi.fn(),
  resumeSession: vi.fn(),
  revokeSession: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("@scalius/core/modules/assistant", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@scalius/core/modules/assistant")
  >();
  return {
    ...actual,
    createAssistantSession: mocks.createSession,
    bindAssistantAgentInstance: mocks.bindAgentInstance,
    consumeAssistantRateLimit: mocks.consumeRateLimit,
    resumeAssistantSession: mocks.resumeSession,
    revokeAssistantSession: mocks.revokeSession,
  };
});

vi.mock("./flue-command-execution", () => ({
  executeStorefrontFlueCommand: mocks.executeCommand,
  failure: (code: string, message: string, retryable: boolean) => ({
    success: false,
    error: { code, message, retryable },
  }),
}));

import {
  STOREFRONT_ASSISTANT_AUDIENCE,
  STOREFRONT_ASSISTANT_AUTHORITY_PATHS,
  STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX,
  STOREFRONT_ASSISTANT_SESSION_COOKIE,
  STOREFRONT_ASSISTANT_SUBJECT_PATTERN,
  isExactInternalStorefrontAssistantRequest,
} from "./storefront-assistant-contract";
import { storefrontAssistantAuthorityRoutes } from "./storefront-assistant";

type TestSession = {
  id: string;
  surface: "storefront" | "admin";
  actorType: "guest" | "admin";
  actorId: string | null;
  conversationKey: string;
  status: "active" | "revoked" | "expired";
  permissionSnapshotHash: string | null;
  safeMetadata: unknown;
  lastEventSequence: number;
  expiresAt: number;
  lastSeenAt: number;
};

let currentSession: TestSession | null;
let currentCredential: string | null;
const CONVERSATION_ID = "conv_abcdefghijklmnopqrstuv";
const FLUE_SIGNING_KEY = "storefront-flue-thread-signing-key-at-least-32-bytes";

function createTestApp(envOverrides: Partial<Env> = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "storefront-assistant-test-db" };
  const env = {
    STOREFRONT_URL: "https://storefront.test",
    PUBLIC_API_BASE_URL: "https://api.test",
    PROJECT_CACHE_PREFIX: "test-store",
    ASSISTANT_RATE_LIMIT_HMAC_KEY: "R".repeat(32),
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
  app.route(
    "/internal/storefront-assistant",
    storefrontAssistantAuthorityRoutes,
  );
  return { app, db, env };
}

function assistantCookie(credential: string): string {
  return `${STOREFRONT_ASSISTANT_SESSION_COOKIE}=${credential}`;
}

async function post(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  path: string,
  body: unknown = {},
  options: { cookie?: string | null; headers?: Record<string, string> } = {},
  origin = "http://api.internal",
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-scalius-storefront-client-ip": "203.0.113.10",
    ...(options.headers ?? {}),
  };
  if (options.cookie !== null && options.cookie) {
    headers.Cookie = options.cookie;
  }
  return app.request(`${origin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, env);
}

describe("internal Storefront assistant session authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = null;
    currentCredential = null;
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 9,
      resetAt: Date.now() + 3_600_000,
    });
    mocks.executeCommand.mockResolvedValue({
      success: true,
      data: { command: "help", capabilities: [] },
    });

    mocks.createSession.mockImplementation(async (
      _db: unknown,
      input: {
        surface: "storefront";
        actorType: "guest";
        actorId: string;
        conversationKey: string;
        credential: string;
        permissionSnapshotHash: null;
        safeMetadata: unknown;
        ttlSeconds: number;
      },
    ) => {
      currentCredential = input.credential;
      currentSession = {
        id: "as_storefront_1",
        surface: input.surface,
        actorType: input.actorType,
        actorId: input.actorId,
        conversationKey: input.conversationKey,
        status: "active",
        permissionSnapshotHash: input.permissionSnapshotHash,
        safeMetadata: input.safeMetadata,
        lastEventSequence: 0,
        expiresAt: Date.now() + input.ttlSeconds * 1_000,
        lastSeenAt: Date.now(),
      };
      return {
        session: currentSession,
        credential: input.credential,
        replayed: false,
      };
    });

    mocks.resumeSession.mockImplementation(async (
      _db: unknown,
      input: { credential: string },
    ) => {
      if (!currentSession || input.credential !== currentCredential) {
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
  });

  it("recognizes only the exact service-binding host, scheme, method, and path", () => {
    expect(isExactInternalStorefrontAssistantRequest(new Request(
      `http://api.internal${STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
      { method: "POST" },
    ))).toBe(true);

    for (const request of [
      new Request(
        `https://api.internal${STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
        { method: "POST" },
      ),
      new Request(
        `http://public.test${STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
        { method: "POST" },
      ),
      new Request(
        `http://api.internal${STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate}?subject=forged`,
        { method: "POST" },
      ),
      new Request(
        `http://api.internal${STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate}`,
        { method: "GET" },
      ),
    ]) {
      expect(isExactInternalStorefrontAssistantRequest(request)).toBe(false);
    }
  });

  it("returns a bland no-store 404 before body or D1 work on public hosts", async () => {
    const { app, env } = createTestApp();
    const response = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      {
        conversationId: CONVERSATION_ID,
        subject: "forged",
        customerPhone: "+8801700000000",
      },
      {},
      "https://api.test",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: false,
      error: "not_found",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("admits Storefront Flue commands only through bound instance authority", async () => {
    const { app, db, env } = createTestApp();
    const response = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program: "help" },
      { cookie: null },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { command: "help", capabilities: [] },
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      env,
    }), {
      instanceId: `v1.${"i".repeat(43)}`,
      program: "help",
    });
    expect((mocks.executeCommand.mock.calls[0]?.[0] as { get(name: string): unknown })
      .get("db")).toBe(db);
  });

  it("rejects Storefront command identity injection and expanded bodies", async () => {
    const { app, env } = createTestApp();
    const injected = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program: "help" },
      {
        cookie: null,
        headers: { "X-Scalius-Principal-Id": "forged" },
      },
    );
    expect(injected.status).toBe(400);
    await expect(injected.json()).resolves.toMatchObject({
      success: false,
      error: { code: "invalid_request", retryable: false },
    });
    const cookieInjected = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program: "help" },
      { cookie: "caller=controlled" },
    );
    expect(cookieInjected.status).toBe(400);
    await expect(cookieInjected.json()).resolves.toMatchObject({
      success: false,
      error: { code: "invalid_request", retryable: false },
    });
    const expanded = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program: "help", subject: "forged" },
      { cookie: null },
    );
    expect(expanded.status).toBe(400);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("accepts the maximum parser-valid escaped command envelope within 16 KiB", async () => {
    const { app, env } = createTestApp();
    const program = `prepare catalog.test -- ${JSON.stringify({
      query: "\\".repeat(2_048),
    })}`;
    expect(new TextEncoder().encode(JSON.stringify({
      instanceId: `v1.${"i".repeat(43)}`,
      program,
    })).byteLength).toBeGreaterThan(8 * 1_024);
    mocks.executeCommand.mockResolvedValueOnce({
      success: false,
      error: {
        code: "mutation_not_ready",
        message: "Use the visible storefront controls.",
        retryable: false,
      },
    });

    const response = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueCommand,
      { instanceId: `v1.${"i".repeat(43)}`, program },
      { cookie: null },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "mutation_not_ready" },
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      expect.anything(),
      { instanceId: `v1.${"i".repeat(43)}`, program },
    );
  });

  it("creates a strong guest-only subject and credential bound to hashed deployment metadata", async () => {
    const { app, db, env } = createTestApp();
    const response = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );

    expect(response.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(db, {
      scope: "storefront.session.create",
      bucket: "ipv4:203.0.113.10",
      hashKey: "R".repeat(32),
      limit: 10,
      windowSeconds: 3_600,
    });
    const [calledDb, input] = mocks.createSession.mock.calls[0]!;
    expect(calledDb).toBe(db);
    expect(input).toMatchObject({
      surface: "storefront",
      actorType: "guest",
      actorId: expect.stringMatching(STOREFRONT_ASSISTANT_SUBJECT_PATTERN),
      conversationKey: CONVERSATION_ID,
      credential: expect.stringMatching(/^session_asst_[A-Za-z0-9_-]{43}$/),
      permissionSnapshotHash: null,
      safeMetadata: {
        schemaVersion: 1,
        deploymentBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      ttlSeconds: 28_800,
    });
    expect(JSON.stringify(input.safeMetadata)).not.toMatch(
      /https?:|phone|email|receipt|payment|customer|admin/i,
    );

    const bodyText = await response.text();
    expect(bodyText).toContain(input.actorId);
    expect(bodyText).toContain(STOREFRONT_ASSISTANT_AUDIENCE);
    expect(bodyText).toContain(CONVERSATION_ID);
    expect(bodyText).not.toContain(input.credential);
    expect(bodyText).not.toContain("conversationKey");
    expect(bodyText).not.toContain("deploymentBindingHash");

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(
      `${STOREFRONT_ASSISTANT_SESSION_COOKIE}=${input.credential}`,
    );
    expect(setCookie).toContain(
      `Path=${STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX}${CONVERSATION_ID}`,
    );
    expect(setCookie).toContain("Max-Age=28800");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain("Domain=");
  });

  it("rate-limits session minting with only a normalized HMAC/D1 client bucket", async () => {
    const { app, env } = createTestApp();
    mocks.consumeRateLimit.mockRejectedValueOnce(
      new RateLimitError("Assistant request limit reached.", 60),
    );
    const limited = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );
    expect(limited.status).toBe(429);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(await limited.text()).not.toContain("203.0.113.10");

    const missingIdentity = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
      { headers: { "x-scalius-storefront-client-ip": "" } },
    );
    expect(missingIdentity.status).toBe(503);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied identity, authority, PII, URLs, and credential headers", async () => {
    const { app, env } = createTestApp();
    for (const body of [
      {
        conversationId: CONVERSATION_ID,
        subject: `storefront_subject_${"A".repeat(43)}`,
      },
      { conversationId: CONVERSATION_ID, actorType: "admin" },
      { conversationId: CONVERSATION_ID, customerPhone: "+8801700000000" },
      { conversationId: CONVERSATION_ID, receiptToken: "chk_secret" },
      { conversationId: CONVERSATION_ID, url: "https://evil.test" },
    ]) {
      const response = await post(
        app,
        env,
        STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
        body,
      );
      expect(response.status).toBe(400);
    }

    const headerInjection = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
      { headers: { Authorization: "Bearer forged" } },
    );
    expect(headerInjection.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("resolves only the exact credential cookie and server-bound Storefront guest session", async () => {
    const { app, env } = createTestApp();
    await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );
    const credential = currentCredential!;
    const response = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionResolve,
      { conversationId: CONVERSATION_ID },
      { cookie: assistantCookie(credential) },
    );

    expect(response.status).toBe(200);
    expect(mocks.resumeSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        credential,
        expectedSurface: "storefront",
        expectedConversationKey: CONVERSATION_ID,
        expectedPermissionSnapshotHash: null,
        expectedSafeMetadata: currentSession!.safeMetadata,
      }),
    );
    const text = await response.text();
    expect(text).toContain(currentSession!.actorId!);
    expect(text).not.toContain(credential);
  });

  it("fails closed across missing, malformed, duplicate, cross-surface, and expired sessions", async () => {
    const { app, env } = createTestApp();
    await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );
    const credential = currentCredential!;

    for (const cookie of [
      null,
      assistantCookie("session_asst_short"),
      `${assistantCookie(credential)}; ${assistantCookie(credential)}`,
    ]) {
      const response = await post(
        app,
        env,
        STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionResolve,
        { conversationId: CONVERSATION_ID },
        { cookie },
      );
      expect(response.status).toBe(401);
    }

    currentSession = {
      ...currentSession!,
      surface: "admin",
      actorType: "admin",
    };
    const crossSurface = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionResolve,
      { conversationId: CONVERSATION_ID },
      { cookie: assistantCookie(credential) },
    );
    expect(crossSurface.status).toBe(401);

    currentSession = {
      ...currentSession!,
      surface: "storefront",
      actorType: "guest",
      expiresAt: Date.now() - 1,
    };
    const expired = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionResolve,
      { conversationId: CONVERSATION_ID },
      { cookie: assistantCookie(credential) },
    );
    expect(expired.status).toBe(401);
  });

  it("fails resolve closed when the store or environment binding changes", async () => {
    const { app, env } = createTestApp();
    await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );

    const driftedEnv = {
      ...env,
      STOREFRONT_URL: "https://other-storefront.test",
    };
    const response = await post(
      app,
      driftedEnv,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionResolve,
      { conversationId: CONVERSATION_ID },
      { cookie: assistantCookie(currentCredential!) },
    );
    expect(response.status).toBe(401);
  });

  it("revokes only the resolved session and clears the credential cookie", async () => {
    const { app, env } = createTestApp();
    await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );
    const response = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionRevoke,
      { conversationId: CONVERSATION_ID },
      { cookie: assistantCookie(currentCredential!) },
    );

    expect(response.status).toBe(200);
    expect(mocks.revokeSession).toHaveBeenCalledWith(
      expect.anything(),
      { sessionId: "as_storefront_1" },
    );
    expect(response.headers.get("Set-Cookie")).toContain(
      `${STOREFRONT_ASSISTANT_SESSION_COOKIE}=; Max-Age=0`,
    );
    expect(response.headers.get("Set-Cookie")).toContain(
      `Path=${STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX}${CONVERSATION_ID}`,
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { revoked: true, changed: true, session: { status: "revoked" } },
    });
  });

  it("admits and idempotently replays only the current credential-bound Storefront thread", async () => {
    const { app, db, env } = createTestApp();
    await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );
    const credential = currentCredential!;
    const options = { cookie: assistantCookie(credential) };
    const [first, replay] = await Promise.all([
      post(
        app,
        env,
        STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        { threadId: CONVERSATION_ID },
        options,
      ),
      post(
        app,
        env,
        STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        { threadId: CONVERSATION_ID },
        options,
      ),
    ]);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(mocks.resumeSession).toHaveBeenNthCalledWith(1, db, {
      credential,
      expectedSurface: "storefront",
      expectedConversationKey: CONVERSATION_ID,
      expectedPermissionSnapshotHash: null,
      expectedSafeMetadata: currentSession!.safeMetadata,
      touchAfterSeconds: 300,
    });
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
      surface: "storefront",
      instanceId: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
      tenantId: expect.stringMatching(/^tenant_[A-Za-z0-9_-]{43}$/u),
      principalId: expect.stringMatching(/^principal_[A-Za-z0-9_-]{43}$/u),
      threadId: CONVERSATION_ID,
      expiresAt: currentSession!.expiresAt,
    });
    expect(replayBody.data.agent).toEqual(firstBody.data.agent);
    expect(mocks.bindAgentInstance).toHaveBeenNthCalledWith(1, db, {
      sessionId: "as_storefront_1",
      agentInstanceId: firstBody.data.agent.instanceId,
    });
    const responseCanary = JSON.stringify(firstBody);
    expect(responseCanary).not.toContain(credential);
    expect(responseCanary).not.toContain(currentSession!.actorId!);
    expect(responseCanary).not.toContain(FLUE_SIGNING_KEY);
    expect(responseCanary).not.toMatch(/cookie|credential|actorId|sessionId/);
  });

  it("fails Storefront admission closed across thread, session, surface, tenant, expiry, and binding drift", async () => {
    const { app, env } = createTestApp();
    await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );
    const credential = currentCredential!;
    const options = { cookie: assistantCookie(credential) };

    const crossThread = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: "conv_abcdefghijklmnopqrstuw" },
      options,
    );
    expect(crossThread.status).toBe(401);

    const wrongSession = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      { cookie: assistantCookie(`session_asst_${"Z".repeat(43)}`) },
    );
    expect(wrongSession.status).toBe(401);

    currentSession = { ...currentSession!, surface: "admin", actorType: "admin" };
    const crossSurface = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      options,
    );
    expect(crossSurface.status).toBe(401);

    currentSession = {
      ...currentSession!,
      surface: "storefront",
      actorType: "guest",
    };
    const crossTenant = await post(
      app,
      { ...env, STOREFRONT_URL: "https://other-storefront.test" },
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      options,
    );
    expect(crossTenant.status).toBe(401);

    currentSession = { ...currentSession!, status: "revoked" };
    const revoked = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      options,
    );
    expect(revoked.status).toBe(401);

    currentSession = {
      ...currentSession!,
      status: "active",
      expiresAt: Date.now() - 1,
    };
    const expired = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      options,
    );
    expect(expired.status).toBe(401);

    currentSession = {
      ...currentSession!,
      expiresAt: Date.now() + 60_000,
      status: "active",
    };
    mocks.bindAgentInstance.mockRejectedValueOnce(
      new ConflictError("Assistant session agent binding changed."),
    );
    const conflict = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      options,
    );
    expect(conflict.status).toBe(409);
  });

  it("rejects malformed, injected, public, and unconfigured Storefront Flue admission", async () => {
    const { app, env } = createTestApp();
    await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
      { conversationId: CONVERSATION_ID },
    );
    const options = { cookie: assistantCookie(currentCredential!) };
    for (const body of [
      { threadId: "not_a_conversation" },
      { threadId: CONVERSATION_ID, subject: "forged" },
      { threadId: `conv_${"a".repeat(65)}` },
      { threadId: CONVERSATION_ID, padding: "x".repeat(3_000) },
    ]) {
      const response = await post(
        app,
        env,
        STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        body,
        options,
      );
      expect(response.status).toBe(400);
    }
    const injected = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      {
        cookie: options.cookie,
        headers: { "X-Scalius-Principal-Id": "forged" },
      },
    );
    expect(injected.status).toBe(400);

    const publicResponse = await post(
      app,
      env,
      STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
      { threadId: CONVERSATION_ID },
      options,
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
      { STOREFRONT_URL: undefined as never },
    ]) {
      const configured = createTestApp(envOverrides);
      await post(
        configured.app,
        configured.env,
        STOREFRONT_ASSISTANT_AUTHORITY_PATHS.sessionCreate,
        { conversationId: CONVERSATION_ID },
      );
      const response = await post(
        configured.app,
        configured.env,
        STOREFRONT_ASSISTANT_AUTHORITY_PATHS.flueAdmit,
        { threadId: CONVERSATION_ID },
        { cookie: assistantCookie(currentCredential!) },
      );
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain(FLUE_SIGNING_KEY);
      expect(text).not.toContain(currentCredential!);
    }
  });
});
