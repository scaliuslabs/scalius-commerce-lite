import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoSeedRbacIfNeeded: vi.fn(async () => undefined),
  createAuth: vi.fn(),
}));

vi.mock("@scalius/core/auth", () => ({
  createAuth: mocks.createAuth,
}));

vi.mock("@scalius/core/auth/rbac/auto-seed", () => ({
  autoSeedRbacIfNeeded: mocks.autoSeedRbacIfNeeded,
}));

import { errorResponseFromError } from "../../utils/api-response";
import { adminAuthManagementRoutes, authSetupRoutes } from "./auth-management";

beforeEach(() => {
  vi.clearAllMocks();
});

function createDbMock(options: { matchingSession?: boolean } = {}) {
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const get = vi.fn(async () =>
    options.matchingSession === false ? null : { id: "session_1" },
  );

  return {
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get })),
      })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

function createTestApp(
  db: ReturnType<typeof createDbMock>,
  options: { twoFactorEnabled?: boolean; session?: { id: string; twoFactorVerified?: boolean } | null } = {},
) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", {
      id: "user_1",
      email: "admin@example.com",
      twoFactorEnabled: options.twoFactorEnabled ?? true,
    } as never);
    if (options.session !== null) {
      c.set("session", options.session ?? { id: "session_1" });
    }
    await next();
  });
  app.route("/auth", adminAuthManagementRoutes);
  return app;
}

function createSetupDbMock() {
  const countWhere = vi.fn(async () => [{ count: 0 }]);
  const existingUserGet = vi.fn(async () => ({ id: "existing_user" }));
  const existingUserWhere = vi.fn(() => ({ get: existingUserGet }));
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const deleteWhere = vi.fn(async () => undefined);

  return {
    __deleteWhere: deleteWhere,
    __existingUserGet: existingUserGet,
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    delete: vi.fn(() => ({ where: deleteWhere })),
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() =>
        "count" in selection
          ? { where: countWhere }
          : { where: existingUserWhere },
      ),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

function createSetupTestApp(db: ReturnType<typeof createSetupDbMock>) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/setup", authSetupRoutes);
  return app;
}

function duplicateUserError() {
  return {
    body: {
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "User already exists. Use another email.",
    },
  };
}

function setupRequestBody(password = "ScaliusLocal123!") {
  return JSON.stringify({
    name: "Existing Admin",
    email: "admin@example.com",
    password,
  });
}

describe("admin auth management 2FA completion", () => {
  it("marks the current session verified when the Better Auth session-token proof matches", async () => {
    const db = createDbMock();
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/complete-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "session_token_from_successful_2fa_verify" }),
    });

    expect(response.status).toBe(200);
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorVerified: true });
    expect(db.__updateWhere).toHaveBeenCalledTimes(1);
  });

  it("rejects completion when the session-token proof does not match the current session", async () => {
    const db = createDbMock({ matchingSession: false });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/complete-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "session_token_from_another_session_or_guess" }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(db.__updateSet).not.toHaveBeenCalled();
  });

  it("rejects completion when 2FA is not enabled for the current account", async () => {
    const db = createDbMock();
    const app = createTestApp(db, { twoFactorEnabled: false });

    const response = await app.request("/api/v1/admin/auth/2fa/complete-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "session_token_from_successful_2fa_verify" }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(db.__updateSet).not.toHaveBeenCalled();
  });
});

describe("admin auth management 2FA method changes", () => {
  it("verifies the target method code before updating the preferred 2FA method", async () => {
    const db = createDbMock();
    const verifyTwoFactorOTP = vi.fn().mockResolvedValue({ token: "verified_session_token" });
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTwoFactorOTP,
      },
    });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request("/api/v1/admin/auth/2fa/method", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "email", code: "123456" }),
    });

    expect(response.status).toBe(200);
    expect(verifyTwoFactorOTP).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { code: "123456", trustDevice: false },
    });
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorVerified: true });
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorMethod: "email" });
  });

  it("rejects a preferred method update when the target method code is invalid", async () => {
    const db = createDbMock();
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTOTP: vi.fn().mockRejectedValue(new Error("Code expired")),
      },
    });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request("/api/v1/admin/auth/2fa/method", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "totp", code: "000000" }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(db.__updateSet).not.toHaveBeenCalledWith({ twoFactorMethod: "totp" });
  });
});

describe("admin auth management legacy 2FA verification", () => {
  it("marks the current session verified when the Better Auth token proof matches", async () => {
    const db = createDbMock();
    const verifyTOTP = vi.fn().mockResolvedValue({ token: "verified_current_session_token" });
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTOTP,
      },
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "totp", code: "123456" }),
    });

    expect(response.status).toBe(200);
    expect(verifyTOTP).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { code: "123456", trustDevice: false },
    });
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorVerified: true });
  });

  it("maps expired or invalid Better Auth verification errors to validation errors", async () => {
    const db = createDbMock();
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTOTP: vi.fn().mockRejectedValue(new Error("Code expired")),
      },
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "totp", code: "000000" }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(db.__updateSet).not.toHaveBeenCalled();
  });

  it("rejects token proofs that do not belong to the current session and user", async () => {
    const db = createDbMock({ matchingSession: false });
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTOTP: vi.fn().mockResolvedValue({ token: "other_session_token" }),
      },
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "totp", code: "123456" }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(db.__updateSet).not.toHaveBeenCalled();
  });
});

describe("first-admin setup recovery", () => {
  it("does not promote an existing account when the submitted password cannot authenticate it", async () => {
    const db = createSetupDbMock();
    const signInEmail = vi.fn().mockRejectedValue(new Error("Invalid password"));
    mocks.createAuth.mockReturnValue({
      api: {
        signInEmail,
        signUpEmail: vi.fn().mockRejectedValue(duplicateUserError()),
      },
    });
    const app = createSetupTestApp(db);

    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: setupRequestBody("DifferentPassword123!"),
    }, {});
    const body = await response.json() as { error?: { code?: string; message?: string } };

    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body.error?.code).toBe("CONFLICT");
    expect(body.error?.message).toContain("existing password");
    expect(db.__updateSet).not.toHaveBeenCalled();
    expect(mocks.autoSeedRbacIfNeeded).not.toHaveBeenCalled();
  });

  it("promotes an existing account only after the submitted password authenticates it", async () => {
    const db = createSetupDbMock();
    const signInEmail = vi.fn().mockResolvedValue({ token: "temporary_setup_session" });
    mocks.createAuth.mockReturnValue({
      api: {
        signInEmail,
        signUpEmail: vi.fn().mockRejectedValue(duplicateUserError()),
      },
    });
    const app = createSetupTestApp(db);

    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: setupRequestBody(),
    }, {});

    expect(response.status, await response.clone().text()).toBe(201);
    expect(signInEmail).toHaveBeenCalledWith({
      body: {
        email: "admin@example.com",
        password: "ScaliusLocal123!",
      },
    });
    expect(db.__deleteWhere).toHaveBeenCalledTimes(1);
    expect(db.__updateSet).toHaveBeenCalledWith({
      name: "Existing Admin",
      role: "admin",
      isSuperAdmin: true,
      emailVerified: true,
    });
    expect(db.__updateWhere).toHaveBeenCalledTimes(1);
    expect(mocks.autoSeedRbacIfNeeded).toHaveBeenCalledTimes(1);
  });
});
