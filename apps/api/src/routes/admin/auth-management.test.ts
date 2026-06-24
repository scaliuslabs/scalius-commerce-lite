import { OpenAPIHono } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoSeedRbacIfNeeded: vi.fn(async () => undefined),
  claimAdminSetup: vi.fn(async () => ({
    singletonKey: "first_admin" as const,
    claimId: "setup_claim_test",
  })),
  completeAdminSetupClaimWithUserPromotion: vi.fn(async () => undefined),
  createAuth: vi.fn(),
  enforceAdminSetupRateLimit: vi.fn(async () => undefined),
  markAdminSetupClaimCompleted: vi.fn(async () => undefined),
  markAdminSetupClaimFailed: vi.fn(async () => undefined),
  assignRoleToUser: vi.fn(async () => undefined),
}));

vi.mock("@scalius/core/auth", () => ({
  claimAdminSetup: mocks.claimAdminSetup,
  completeAdminSetupClaimWithUserPromotion: mocks.completeAdminSetupClaimWithUserPromotion,
  createAuth: mocks.createAuth,
  enforceAdminSetupRateLimit: mocks.enforceAdminSetupRateLimit,
  markAdminSetupClaimCompleted: mocks.markAdminSetupClaimCompleted,
  markAdminSetupClaimFailed: mocks.markAdminSetupClaimFailed,
}));

vi.mock("@scalius/core/auth/rbac/auto-seed", () => ({
  autoSeedRbacIfNeeded: mocks.autoSeedRbacIfNeeded,
}));

vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  assignRoleToUser: mocks.assignRoleToUser,
}));

import { errorResponseFromError } from "../../utils/api-response";
import { ConflictError } from "../../utils/api-error";
import { adminAuthManagementRoutes, authSetupRoutes } from "./auth-management";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimAdminSetup.mockResolvedValue({
    singletonKey: "first_admin",
    claimId: "setup_claim_test",
  });
  mocks.completeAdminSetupClaimWithUserPromotion.mockResolvedValue(undefined);
  mocks.enforceAdminSetupRateLimit.mockResolvedValue(undefined);
  mocks.markAdminSetupClaimCompleted.mockResolvedValue(undefined);
  mocks.markAdminSetupClaimFailed.mockResolvedValue(undefined);
});

function createDbMock(options: { matchingSession?: boolean } = {}) {
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const deleteWhere = vi.fn(async () => undefined);
  const get = vi.fn(async () =>
    options.matchingSession === false ? null : { id: "session_1" },
  );

  return {
    __deleteWhere: deleteWhere,
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    delete: vi.fn(() => ({ where: deleteWhere })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get })),
      })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

function createTestApp(
  db: unknown,
  options: {
    twoFactorEnabled?: boolean;
    session?: { id: string; twoFactorVerified?: boolean } | null;
    user?: Record<string, unknown>;
  } = {},
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
      name: "Admin",
      role: "admin",
      twoFactorEnabled: options.twoFactorEnabled ?? true,
      ...options.user,
    } as never);
    if (options.session !== null) {
      c.set("session", options.session ?? { id: "session_1" });
    }
    await next();
  });
  app.route("/auth", adminAuthManagementRoutes);
  return app;
}

function createAdminUserListDbMock(options: {
  adminUsers?: Array<{
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    twoFactorEnabled: boolean;
    mustChangePassword: boolean;
    mustEnrollTwoFactor: boolean;
    isSuperAdmin: boolean;
    createdAt: number;
  }>;
  roleRows?: Array<{ id: string; name: string; displayName: string }>;
  overrideRows?: Array<{ permissionName: string; granted: boolean }>;
} = {}) {
  const adminUsers = options.adminUsers ?? [
    {
      id: "admin_2",
      name: "Ops Admin",
      email: "ops@example.com",
      emailVerified: true,
      image: null,
      twoFactorEnabled: true,
      mustChangePassword: false,
      mustEnrollTwoFactor: false,
      isSuperAdmin: false,
      createdAt: 1,
    },
  ];
  const roleRows = options.roleRows ?? [
    { id: "role_1", name: "manager", displayName: "Manager" },
  ];
  const overrideRows = options.overrideRows ?? [
    { permissionName: "products.view", granted: true },
    { permissionName: "orders.refund", granted: false },
  ];

  return {
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(async () => adminUsers),
          })),
        })),
      })),
    })),
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() => {
        if ("displayName" in selection) {
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn(async () => roleRows),
            })),
          };
        }
        if ("permissionName" in selection) {
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn(async () => overrideRows),
            })),
          };
        }
        return { where: vi.fn(async () => []) };
      }),
    })),
  };
}

function createAdminDeleteDbMock(options: {
  targetUser?: { id: string; role: string | null; isSuperAdmin: boolean } | null;
  targetPrincipalRows?: Array<{ id: string }>;
  adminPrincipalRows?: Array<{ id: string }>;
} = {}) {
  const targetUser = options.targetUser ?? {
    id: "rbac_admin",
    role: "user",
    isSuperAdmin: false,
  };
  const targetPrincipalRows = options.targetPrincipalRows ?? [{ id: "rbac_admin" }];
  const adminPrincipalRows = options.adminPrincipalRows ?? [
    { id: "user_1" },
    { id: "rbac_admin" },
  ];
  const deleteWhere = vi.fn(async () => undefined);
  const principalWhereCalls: unknown[] = [];

  return {
    __deleteWhere: deleteWhere,
    __principalWhereCalls: principalWhereCalls,
    delete: vi.fn(() => ({ where: deleteWhere })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => targetUser),
        })),
      })),
    })),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(async (predicate: unknown) => {
              principalWhereCalls.push(predicate);
              return principalWhereCalls.length === 1
                ? targetPrincipalRows
                : adminPrincipalRows;
            }),
          })),
        })),
      })),
    })),
  };
}

function createAdminInviteDbMock() {
  const getQueue = [
    vi.fn(async () => ({ id: "role_1" })),
    vi.fn(async () => null),
  ];
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  return {
    __getQueue: getQueue,
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: (getQueue.shift() ?? vi.fn(async () => null)),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

function createSetupDbMock(options: { adminExistsResult?: unknown } = {}) {
  const adminExistsGet = vi.fn(async () =>
    Object.prototype.hasOwnProperty.call(options, "adminExistsResult")
      ? options.adminExistsResult
      : null
  );
  const adminExistsLimit = vi.fn(() => ({ get: adminExistsGet }));
  const adminExistsWhere = vi.fn(() => ({ limit: adminExistsLimit }));
  const existingUserGet = vi.fn(async () => ({ id: "existing_user" }));
  const existingUserWhere = vi.fn(() => ({ get: existingUserGet }));
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const deleteWhere = vi.fn(async () => undefined);

  return {
    __adminExistsGet: adminExistsGet,
    __adminExistsLimit: adminExistsLimit,
    __adminExistsWhere: adminExistsWhere,
    __deleteWhere: deleteWhere,
    __existingUserGet: existingUserGet,
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    delete: vi.fn(() => ({ where: deleteWhere })),
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() =>
        "found" in selection
          ? { where: adminExistsWhere }
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

describe("admin auth management user permissions", () => {
  it("lists admin users after RBAC middleware admits a non-legacy-role admin", async () => {
    const db = createAdminUserListDbMock();
    const app = createTestApp(db, {
      user: {
        role: "operations_manager",
        twoFactorEnabled: false,
      },
    });

    const response = await app.request("/api/v1/admin/auth/users", {
      method: "GET",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as {
      data?: {
        users?: Array<{
          id: string;
          roles: Array<{ name: string }>;
          overrides: { grants: string[]; denials: string[] };
        }>;
      };
    };
    expect(body.data?.users).toEqual([
      expect.objectContaining({
        id: "admin_2",
        roles: [{ id: "role_1", name: "manager", displayName: "Manager" }],
        overrides: {
          grants: ["products.view"],
          denials: ["orders.refund"],
        },
      }),
    ]);
  });

  it("lists direct-permission admin principals even when they have no assigned roles", async () => {
    const db = createAdminUserListDbMock({
      adminUsers: [
        {
          id: "direct_perm_admin",
          name: "Direct Permission Admin",
          email: "direct@example.com",
          emailVerified: true,
          image: null,
          twoFactorEnabled: true,
          mustChangePassword: false,
          mustEnrollTwoFactor: false,
          isSuperAdmin: false,
          createdAt: 1,
        },
      ],
      roleRows: [],
      overrideRows: [
        { permissionName: "team.view", granted: true },
      ],
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/users", {
      method: "GET",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as {
      data?: {
        users?: Array<{
          id: string;
          roles: Array<{ name: string }>;
          overrides: { grants: string[]; denials: string[] };
        }>;
      };
    };
    expect(body.data?.users).toEqual([
      expect.objectContaining({
        id: "direct_perm_admin",
        roles: [],
        overrides: {
          grants: ["team.view"],
          denials: [],
        },
      }),
    ]);
  });

  it("does not re-check legacy user.role inside user-management handlers", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "auth-management.ts"),
      "utf8",
    );

    expect(source).not.toContain('sessionUser.role !== "admin"');
    expect(source).not.toContain('.where(eq(user.role, "admin"))');
    expect(source).toContain("selectDistinct");
    expect(source).toContain("isNotNull(userRoles.id)");
    expect(source).toContain("isNotNull(userPermissions.id)");
    expect(source).toContain("eq(userPermissions.granted, true)");
    expect(source).not.toContain("Only administrators can create new admin users");
    expect(source).not.toContain("Only administrators can delete admin users");
  });

  it("deletes a role-bearing admin principal even when the legacy role is not admin", async () => {
    const db = createAdminDeleteDbMock();
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/users/rbac_admin", {
      method: "DELETE",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(db.__deleteWhere).toHaveBeenCalledOnce();
    expect(db.__principalWhereCalls).toHaveLength(2);
  });

  it("does not delete plain non-admin Better Auth users through team management", async () => {
    const db = createAdminDeleteDbMock({
      targetPrincipalRows: [],
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/users/customer_user", {
      method: "DELETE",
    });
    const body = await response.json() as { error?: { code?: string; message?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(db.__deleteWhere).not.toHaveBeenCalled();
  });
});

describe("admin auth management team invites", () => {
  it("validates setup URL configuration before creating a blocked invited admin", async () => {
    const db = createAdminInviteDbMock();
    const signUpEmail = vi.fn();
    const requestPasswordReset = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail,
        requestPasswordReset,
      },
    });
    const app = createTestApp(db, {
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request("/api/v1/admin/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops Admin",
        email: "ops@example.com",
        roleId: "role_1",
      }),
    }, {} as never);
    const body = await response.json() as { error?: { code?: string; message?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(db.__updateSet).not.toHaveBeenCalled();
    expect(mocks.assignRoleToUser).not.toHaveBeenCalled();
  });

  it("creates blocked invited admins and sends a one-use password setup link", async () => {
    const db = createAdminInviteDbMock();
    const signUpEmail = vi.fn().mockResolvedValue({
      user: { id: "new_admin" },
    });
    const requestPasswordReset = vi.fn().mockResolvedValue({
      status: true,
      message: "If this email exists in our system, check your email for the reset link",
    });
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail,
        requestPasswordReset,
      },
    });
    const app = createTestApp(db, {
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request("/api/v1/admin/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops Admin",
        email: "ops@example.com",
        roleId: "role_1",
      }),
    }, { BETTER_AUTH_URL: "https://admin.scalius.test" } as never);

    expect(response.status, await response.clone().text()).toBe(201);
    expect(signUpEmail).toHaveBeenCalledWith({
      body: {
        name: "Ops Admin",
        email: "ops@example.com",
        password: expect.any(String),
      },
    });
    const generatedPassword = signUpEmail.mock.calls[0]?.[0]?.body?.password;
    expect(generatedPassword).toHaveLength(32);
    expect(db.__updateSet).toHaveBeenCalledWith({
      role: "admin",
      emailVerified: true,
      mustChangePassword: true,
      mustEnrollTwoFactor: true,
    });
    expect(mocks.assignRoleToUser).toHaveBeenCalledWith(
      db,
      "new_admin",
      "role_1",
      "user_1",
      undefined,
    );
    expect(requestPasswordReset).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: {
        email: "ops@example.com",
        redirectTo: "/auth/reset-password",
      },
    });

    const bodyText = await response.clone().text();
    expect(bodyText).toContain("secure setup link");
    expect(bodyText).toContain("onboardingRequired");
    expect(bodyText).not.toContain(String(generatedPassword));
  });

  it("keeps team invites off raw credential emails", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "auth-management.ts"),
      "utf8",
    );

    expect(source).toContain("requestPasswordReset");
    expect(source).toContain("mustChangePassword: true");
    expect(source).toContain("mustEnrollTwoFactor: true");
    expect(source).not.toContain("sendAdminInviteEmail");
    expect(source).not.toContain("Temporary Password");
  });
});

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
  it("accepts a same-origin session-token proof before updating the preferred 2FA method", async () => {
    const db = createDbMock();
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request("/api/v1/admin/auth/2fa/method", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "email",
        sessionToken: "same_origin_verified_session_token_123456789",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createAuth).not.toHaveBeenCalled();
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorVerified: true });
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorMethod: "email",
      mustEnrollTwoFactor: false,
    }));
  });

  it("rejects a preferred method update when the same-origin proof does not match the current session", async () => {
    const db = createDbMock({ matchingSession: false });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request("/api/v1/admin/auth/2fa/method", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "email",
        sessionToken: "another_session_token_123456789012345",
      }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(db.__updateSet).not.toHaveBeenCalled();
  });

  it("verifies the target method code before updating the preferred 2FA method", async () => {
    const db = createDbMock();
    const verifyTwoFactorOTP = vi.fn().mockResolvedValue({
      response: { token: "verified_session_token" },
      headers: new Headers(),
    });
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
      returnHeaders: true,
    });
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorVerified: true });
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorMethod: "email",
      mustEnrollTwoFactor: false,
    }));
  });

  it("uses the rotated session cookie when first-time TOTP verification returns a stale token", async () => {
    const db = createDbMock();
    const verifyTOTP = vi.fn().mockResolvedValue({
      response: { token: "old_session_token" },
      headers: new Headers({
        "Set-Cookie": "better-auth.session_token=new_session_token.signature; Path=/; HttpOnly; SameSite=Lax",
      }),
    });
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTOTP,
      },
      options: {},
    });
    const app = createTestApp(db, {
      twoFactorEnabled: false,
      session: { id: "session_1", twoFactorVerified: false },
    });

    const response = await app.request("/api/v1/admin/auth/2fa/method", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "totp", code: "123456" }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=new_session_token.signature");
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorVerified: true });
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorMethod: "totp",
      mustEnrollTwoFactor: false,
    }));
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
    expect(db.__updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ twoFactorMethod: "totp" }));
  });
});

describe("admin auth management password changes", () => {
  it("changes the password and forwards Better Auth's rotated session cookie", async () => {
    const db = createDbMock();
    const changePassword = vi.fn().mockResolvedValue({
      response: { token: "new_session_token", user: { id: "user_1" } },
      headers: new Headers({
        "Set-Cookie": "better-auth.session_token=new_session_token.signature; Path=/; HttpOnly; SameSite=Lax",
      }),
    });
    mocks.createAuth.mockReturnValue({
      api: {
        changePassword,
      },
    });
    const app = createTestApp(db, {
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request("/api/v1/admin/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: "OldPassword123!",
        newPassword: "NewPassword123!",
      }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(changePassword).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: {
        currentPassword: "OldPassword123!",
        newPassword: "NewPassword123!",
        revokeOtherSessions: true,
      },
      returnHeaders: true,
    });
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=new_session_token.signature");
    const body = await response.json() as { data?: Record<string, unknown> };
    expect(body.data?.message).toBe("Password changed successfully");
    expect(JSON.stringify(body)).not.toContain("new_session_token");
  });

  it("rejects password changes without an active session", async () => {
    const db = createDbMock();
    const changePassword = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: {
        changePassword,
      },
    });
    const app = createTestApp(db, { session: null });

    const response = await app.request("/api/v1/admin/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: "OldPassword123!",
        newPassword: "NewPassword123!",
      }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(changePassword).not.toHaveBeenCalled();
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

  it("rejects trusted-device TOTP verification while remembered-device policy is disabled", async () => {
    const db = createDbMock();
    const verifyTOTP = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTOTP,
      },
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "totp", code: "123456", trustDevice: true }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(mocks.createAuth).not.toHaveBeenCalled();
    expect(verifyTOTP).not.toHaveBeenCalled();
    expect(db.__updateSet).not.toHaveBeenCalled();
  });

  it("rejects trusted-device email OTP verification while remembered-device policy is disabled", async () => {
    const db = createDbMock();
    const verifyTwoFactorOTP = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: {
        verifyTwoFactorOTP,
      },
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email", code: "123456", trustDevice: true }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(mocks.createAuth).not.toHaveBeenCalled();
    expect(verifyTwoFactorOTP).not.toHaveBeenCalled();
    expect(db.__updateSet).not.toHaveBeenCalled();
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
  it("treats D1 no-row undefined as no existing admin", async () => {
    const db = createSetupDbMock({ adminExistsResult: undefined });
    const signUpEmail = vi.fn().mockResolvedValue({
      user: { id: "new_admin" },
    });
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail,
      },
    });
    const app = createSetupTestApp(db);

    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: setupRequestBody(),
    }, {});

    expect(response.status, await response.clone().text()).toBe(201);
    expect(signUpEmail).toHaveBeenCalledTimes(1);
    expect(mocks.claimAdminSetup).toHaveBeenCalledWith(db);
  });

  it("claims D1 setup coordination before creating the first admin even when KV is unavailable", async () => {
    const db = createSetupDbMock();
    const signUpEmail = vi.fn().mockResolvedValue({
      user: { id: "new_admin" },
    });
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail,
      },
    });
    const app = createSetupTestApp(db);

    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: setupRequestBody(),
    }, {});

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.enforceAdminSetupRateLimit).toHaveBeenCalledWith(db, "203.0.113.10");
    expect(mocks.claimAdminSetup).toHaveBeenCalledWith(db);
    expect(signUpEmail).toHaveBeenCalledTimes(1);
    expect(mocks.claimAdminSetup.mock.invocationCallOrder[0]!)
      .toBeLessThan(signUpEmail.mock.invocationCallOrder[0]!);
    expect(mocks.completeAdminSetupClaimWithUserPromotion).toHaveBeenCalledWith(
      db,
      {
        singletonKey: "first_admin",
        claimId: "setup_claim_test",
      },
      { userId: "new_admin" },
    );
    expect(mocks.markAdminSetupClaimCompleted).not.toHaveBeenCalled();
    expect(mocks.markAdminSetupClaimFailed).not.toHaveBeenCalled();
  });

  it("does not call Better Auth when another setup claim is active", async () => {
    const db = createSetupDbMock();
    const signUpEmail = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail,
      },
    });
    mocks.claimAdminSetup.mockRejectedValueOnce(
      new ConflictError("Admin setup is already in progress. Please wait."),
    );
    const app = createSetupTestApp(db);

    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: setupRequestBody(),
    }, {});
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(409);
    expect(body.error?.code).toBe("CONFLICT");
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(mocks.markAdminSetupClaimCompleted).not.toHaveBeenCalled();
    expect(mocks.markAdminSetupClaimFailed).not.toHaveBeenCalled();
  });

  it("marks the setup claim failed when account creation fails after claiming", async () => {
    const db = createSetupDbMock();
    const failure = new Error("signup provider unavailable");
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail: vi.fn().mockRejectedValue(failure),
      },
    });
    const app = createSetupTestApp(db);

    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: setupRequestBody(),
    }, {});

    expect(response.status).toBe(500);
    expect(mocks.markAdminSetupClaimFailed).toHaveBeenCalledWith(
      db,
      {
        singletonKey: "first_admin",
        claimId: "setup_claim_test",
      },
      failure,
    );
    expect(mocks.markAdminSetupClaimCompleted).not.toHaveBeenCalled();
  });

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
    expect(mocks.completeAdminSetupClaimWithUserPromotion).not.toHaveBeenCalled();
    expect(db.__updateSet).not.toHaveBeenCalled();
    expect(mocks.autoSeedRbacIfNeeded).not.toHaveBeenCalled();
  });

  it("does not promote an existing account when password authentication requires 2FA", async () => {
    const db = createSetupDbMock();
    const signInEmail = vi.fn().mockResolvedValue({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    });
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
    const body = await response.json() as { error?: { code?: string; message?: string } };

    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body.error?.code).toBe("CONFLICT");
    expect(body.error?.message).toContain("existing password");
    expect(db.__deleteWhere).not.toHaveBeenCalled();
    expect(mocks.completeAdminSetupClaimWithUserPromotion).not.toHaveBeenCalled();
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
    expect(mocks.completeAdminSetupClaimWithUserPromotion).toHaveBeenCalledWith(
      db,
      {
        singletonKey: "first_admin",
        claimId: "setup_claim_test",
      },
      {
        userId: "existing_user",
        name: "Existing Admin",
      },
    );
    expect(db.__updateSet).not.toHaveBeenCalled();
    expect(db.__updateWhere).not.toHaveBeenCalled();
    expect(mocks.autoSeedRbacIfNeeded).toHaveBeenCalledTimes(1);
  });
});
