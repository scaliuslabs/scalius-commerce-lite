import { OpenAPIHono } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoSeedRbacIfNeeded: vi.fn(async () => undefined),
  claimAdminSetup: vi.fn(async () => ({
    singletonKey: "first_admin" as const,
    claimId: "setup_claim_test",
  })),
  completeAdminSetupClaimWithUserPromotion: vi.fn(async () => undefined),
  createPendingEmailMethodChallenge: vi.fn(),
  createPendingTotpMethodChallenge: vi.fn(),
  createAuth: vi.fn(),
  enforceAdminSetupRateLimit: vi.fn(async () => undefined),
  markAdminSetupClaimCompleted: vi.fn(async () => undefined),
  markAdminSetupClaimFailed: vi.fn(async () => undefined),
  getTwoFactorMethodChallengeIdentifier: vi.fn(
    (userId: string, sessionId: string) =>
      `admin:2fa-method:${userId}:${sessionId}`,
  ),
  readPendingTwoFactorMethodChallenge: vi.fn(),
  verifyPendingTotpCode: vi.fn(),
  assignRoleToUser: vi.fn(async () => undefined),
}));

vi.mock("@scalius/core/auth", () => ({
  claimAdminSetup: mocks.claimAdminSetup,
  completeAdminSetupClaimWithUserPromotion: mocks.completeAdminSetupClaimWithUserPromotion,
  createPendingEmailMethodChallenge: mocks.createPendingEmailMethodChallenge,
  createPendingTotpMethodChallenge: mocks.createPendingTotpMethodChallenge,
  createAuth: mocks.createAuth,
  enforceAdminSetupRateLimit: mocks.enforceAdminSetupRateLimit,
  markAdminSetupClaimCompleted: mocks.markAdminSetupClaimCompleted,
  markAdminSetupClaimFailed: mocks.markAdminSetupClaimFailed,
  getTwoFactorMethodChallengeIdentifier: mocks.getTwoFactorMethodChallengeIdentifier,
  readPendingTwoFactorMethodChallenge: mocks.readPendingTwoFactorMethodChallenge,
  verifyPendingTotpCode: mocks.verifyPendingTotpCode,
}));

vi.mock("@scalius/core/auth/rbac/auto-seed", () => ({
  autoSeedRbacIfNeeded: mocks.autoSeedRbacIfNeeded,
}));

vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  assignRoleToUser: mocks.assignRoleToUser,
}));

import { errorResponseFromError } from "../../utils/api-response";
import { ConflictError } from "../../utils/api-error";
import { createAccountSessionCommandIdFactory } from "./account-session-presentation";
import { adminAuthManagementRoutes, authSetupRoutes } from "./auth-management";

const TEST_ACCOUNT_SESSION_COMMAND_SECRET =
  "test-account-session-command-secret";
const testAccountSessionCommandIdFactory = createAccountSessionCommandIdFactory(
  TEST_ACCOUNT_SESSION_COMMAND_SECRET,
);

async function getTestAccountSessionCommandId(sessionId: string) {
  const createCommandId = await testAccountSessionCommandIdFactory;
  return createCommandId(sessionId);
}

const TEST_ACCOUNT_SESSION_ENV = {
  BETTER_AUTH_SECRET: TEST_ACCOUNT_SESSION_COMMAND_SECRET,
} as Env;

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
  mocks.createPendingTotpMethodChallenge.mockResolvedValue({
    challengeId: "tfmc_0123456789abcdef0123456789abcdef",
    identifier: "admin:2fa-method:user_1:session_1",
    encryptedValue: "encrypted-challenge-value",
    totpUri: "otpauth://totp/Scalius%20Commerce%3Aadmin%40example.com?secret=ABC",
    expiresAt: new Date("2026-07-13T12:10:00.000Z"),
  });
  mocks.createPendingEmailMethodChallenge.mockResolvedValue({
    challengeId: "tfmc_0123456789abcdef0123456789abcdef",
    identifier: "admin:2fa-method:user_1:session_1",
    encryptedValue: "encrypted-email-challenge-value",
    expiresAt: new Date("2026-07-13T12:10:00.000Z"),
  });
  mocks.readPendingTwoFactorMethodChallenge.mockResolvedValue({
    version: 1,
    userId: "user_1",
    sessionId: "session_1",
    method: "totp",
    secret: "pending-raw-secret-with-enough-length",
    encryptedSecret: "encrypted-pending-secret",
    backupCodes: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
    storedBackupCodes: "encrypted-stored-backup-codes",
    expiresAt: Date.now() + 600_000,
  });
  mocks.verifyPendingTotpCode.mockResolvedValue(true);
});

function createDbMock(options: {
  matchingSession?: boolean;
  sessionToken?: string;
} = {}) {
  const updateWhere = vi.fn(() => ({ kind: "update" }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn(() => ({ kind: "insert" }));
  const batch = vi.fn(async () => []);
  const deleteWhere = vi.fn(async () => undefined);
  const get = vi.fn(async () => options.matchingSession === false
    ? null
    : {
        id: "session_1",
        token: options.sessionToken ?? "verified_session_token",
      });

  return {
    __deleteWhere: deleteWhere,
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    __insertValues: insertValues,
    batch,
    insert: vi.fn(() => ({ values: insertValues })),
    delete: vi.fn(() => ({ where: deleteWhere })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get,
          limit: vi.fn(async () => [{ id: "two_factor_1" }]),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

function createTwoFactorMethodChallengeDbMock(options: {
  challengeRows?: Array<{ value: string } | null>;
  duplicateTwoFactor?: boolean;
  existingTwoFactor?: { id: string } | null;
  batchChanges?: number[];
  batchError?: Error;
} = {}) {
  const challengeRows = [...(options.challengeRows ?? [{ value: "encrypted-challenge-value" }])];
  const updateSets: Array<Record<string, unknown>> = [];
  const insertedValues: Array<Record<string, unknown>> = [];
  const batch = vi.fn(async () => {
    if (options.batchError) throw options.batchError;
    return (options.batchChanges ?? [1, 1, 1, 1, 1]).map((changes) => ({
      meta: { changes },
    }));
  });

  return {
    __batch: batch,
    __insertedValues: insertedValues,
    __updateSets: updateSets,
    batch,
    delete: vi.fn(() => ({ where: vi.fn(() => ({ kind: "delete" })) })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertedValues.push(value);
        return { kind: "insert" };
      }),
    })),
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => {
            if ("value" in selection) return challengeRows.shift() ?? null;
            if ("token" in selection) {
              return {
                id: "session_1",
                token: "verified_session_token",
              };
            }
            return options.existingTwoFactor === undefined
              ? { id: "two_factor_1" }
              : options.existingTwoFactor;
          }),
          limit: vi.fn(async () => {
            const authority = options.existingTwoFactor === undefined
              ? { id: "two_factor_1" }
              : options.existingTwoFactor;
            if (!authority) return [];
            return options.duplicateTwoFactor
              ? [authority, { id: "two_factor_2" }]
              : [authority];
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updateSets.push(value);
        return { where: vi.fn(() => ({ kind: "update" })) };
      }),
    })),
  };
}

function createTestApp(
  db: unknown,
  options: {
    twoFactorEnabled?: boolean;
    session?: { id: string; twoFactorVerified?: boolean } | null;
    user?: Record<string, unknown>;
    adminPermissions?: Set<string>;
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
    c.set(
      "adminPermissions",
      options.adminPermissions ?? new Set(["team.manage", "team.manage_roles"]),
    );
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
    banned: boolean;
    banExpires: Date | null;
    invitationId: string | null;
    invitationStatus: "pending" | "accepted" | "revoked" | null;
    invitationDeliveryStatus: "pending" | "sent" | "failed" | null;
    invitationExpiresAt: Date | null;
    invitationLastSentAt: Date | null;
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
      banned: false,
      banExpires: null,
      invitationId: null,
      invitationStatus: null,
      invitationDeliveryStatus: null,
      invitationExpiresAt: null,
      invitationLastSentAt: null,
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
            leftJoin: vi.fn(() => ({
              where: vi.fn(async () => adminUsers),
            })),
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
  targetUser?: {
    id: string;
    role: string | null;
    isSuperAdmin: boolean;
    mustChangePassword: boolean;
    invitationId: string | null;
    invitationStatus: "pending" | "accepted" | "revoked" | null;
  } | null;
  targetPrincipalRows?: Array<{ id: string }>;
  adminPrincipalRows?: Array<{ id: string }>;
} = {}) {
  const targetUser = options.targetUser ?? {
    id: "rbac_admin",
    role: "user",
    isSuperAdmin: false,
    mustChangePassword: true,
    invitationId: "invite_1",
    invitationStatus: "pending",
  };
  const targetPrincipalRows = options.targetPrincipalRows ?? [{ id: "rbac_admin" }];
  const adminPrincipalRows = options.adminPrincipalRows ?? [
    { id: "user_1" },
    { id: "rbac_admin" },
  ];
  const deleteWhere = vi.fn(() => ({ kind: "delete" }));
  const updateWhere = vi.fn(() => ({ kind: "update" }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const batch = vi.fn(async () => []);
  const principalWhereCalls: unknown[] = [];

  return {
    __deleteWhere: deleteWhere,
    __principalWhereCalls: principalWhereCalls,
    batch,
    delete: vi.fn(() => ({ where: deleteWhere })),
    update: vi.fn(() => ({ set: updateSet })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => targetUser),
          })),
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

function createAdminSuspensionDbMock(options: {
  target?: { id: string; isSuperAdmin: boolean; banned: boolean } | null;
  principalRows?: Array<{ id: string }>;
  otherActiveAdminRows?: Array<{ id: string }>;
  batchError?: Error;
} = {}) {
  const target = Object.prototype.hasOwnProperty.call(options, "target")
    ? options.target
    : { id: "admin_2", isSuperAdmin: false, banned: false };
  const principalRows = options.principalRows ?? [{ id: "admin_2" }];
  const otherActiveAdminRows = options.otherActiveAdminRows ?? [{ id: "user_1" }];
  const updateWhere = vi.fn(() => ({ kind: "update" }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const deleteWhere = vi.fn(() => ({ kind: "delete" }));
  const batch = vi.fn(async () => {
    if (options.batchError) throw options.batchError;
    return [];
  });
  let principalCall = 0;

  return {
    __batch: batch,
    __deleteWhere: deleteWhere,
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    batch,
    delete: vi.fn(() => ({ where: deleteWhere })),
    update: vi.fn(() => ({ set: updateSet })),
    select: vi.fn((selection: Record<string, unknown>) => {
      if ("batchGuard" in selection) {
        return { from: vi.fn(() => ({ kind: "guard" })) };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({ get: vi.fn(async () => target) })),
        })),
      };
    }),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(async () => {
              principalCall += 1;
              return principalCall === 1 ? principalRows : otherActiveAdminRows;
            }),
          })),
        })),
      })),
    })),
  };
}

function createAdminInviteDbMock(options: {
  role?: { id: string; name: string } | null;
  rolePermissions?: string[];
} = {}) {
  const role = Object.prototype.hasOwnProperty.call(options, "role")
    ? options.role
    : { id: "role_1", name: "manager" };
  const selectedRolePermissions = options.rolePermissions ?? ["team.manage"];
  const updateWhere = vi.fn(() => ({ kind: "update" }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn(() => ({ kind: "insert" }));
  const batch = vi.fn(async () => []);

  return {
    __batch: batch,
    __insertValues: insertValues,
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    batch,
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() => {
        if ("name" in selection && "id" in selection) {
          return {
            where: vi.fn(() => ({ get: vi.fn(async () => role) })),
          };
        }
        if ("name" in selection) {
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn(async () =>
                selectedRolePermissions.map((name) => ({ name })),
              ),
            })),
          };
        }
        return {
          where: vi.fn(() => ({ get: vi.fn(async () => null) })),
        };
      }),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

function createAdminResendSetupDbMock(options: {
  target?: {
    id: string;
    email: string;
    mustChangePassword: boolean;
    invitationId: string | null;
    invitationStatus: "pending" | "accepted" | "revoked" | null;
  } | null;
  principalRows?: Array<{ id: string }>;
} = {}) {
  const target = Object.prototype.hasOwnProperty.call(options, "target")
    ? options.target
    : {
        id: "pending_admin",
        email: "pending@example.com",
        mustChangePassword: true,
        invitationId: "invite_1",
        invitationStatus: "pending",
      };
  const principalRows = options.principalRows ?? [{ id: "pending_admin" }];
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  return {
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    update: vi.fn(() => ({ set: updateSet })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => target),
          })),
        })),
      })),
    })),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(async () => principalRows),
          })),
        })),
      })),
    })),
  };
}

function createAccountSessionsDbMock(options: {
  currentSession?: Record<string, unknown> | null;
  otherSessions?: Array<Record<string, unknown>>;
  revokedSessionIds?: string[];
} = {}) {
  const baseSession = {
    id: "session_1",
    token: "raw_session_token_must_never_leave_the_api",
    ipAddress: "203.0.113.42",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0 Safari/537.36",
    impersonatedBy: null,
    twoFactorVerified: true,
    createdAt: new Date("2026-07-01T10:00:00.000Z"),
    updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    expiresAt: new Date("2026-07-20T10:00:00.000Z"),
  };
  const currentSession = Object.prototype.hasOwnProperty.call(
    options,
    "currentSession",
  )
    ? options.currentSession
    : baseSession;
  const otherSessions = options.otherSessions ?? [
    {
      ...baseSession,
      id: "session_2",
      ipAddress: "2001:db8:abcd:0012::1",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1",
      twoFactorVerified: false,
    },
  ];
  const revokedSessionIds = options.revokedSessionIds ?? ["session_2"];
  const deleteReturning = vi.fn(async () =>
    revokedSessionIds.map((id) => ({ id })),
  );
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  let selectIndex = 0;

  return {
    __deleteReturning: deleteReturning,
    __deleteWhere: deleteWhere,
    delete: vi.fn(() => ({ where: deleteWhere })),
    select: vi.fn(() => {
      const currentSelectIndex = selectIndex++;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() =>
            currentSelectIndex === 0
              ? { get: vi.fn(async () => currentSession) }
              : {
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(async () => otherSessions),
                  })),
                },
          ),
        })),
      };
    }),
  };
}

function createSetupDbMock(options: { adminExistsResult?: unknown } = {}) {
  const adminExistsGet = vi.fn(async (_query?: SQL) =>
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
    get: adminExistsGet,
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
          banned: false,
          banExpires: null,
          invitationId: null,
          invitationStatus: null,
          invitationDeliveryStatus: null,
          invitationExpiresAt: null,
          invitationLastSentAt: null,
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

  it("projects indefinite bans as suspended administrator state", async () => {
    const db = createAdminUserListDbMock({
      adminUsers: [{
        id: "suspended_admin",
        name: "Suspended Admin",
        email: "suspended@example.com",
        emailVerified: true,
        image: null,
        twoFactorEnabled: true,
        mustChangePassword: false,
        mustEnrollTwoFactor: false,
        banned: true,
        banExpires: null,
        invitationId: null,
        invitationStatus: null,
        invitationDeliveryStatus: null,
        invitationExpiresAt: null,
        invitationLastSentAt: null,
        isSuperAdmin: false,
        createdAt: 1,
      }],
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/users", { method: "GET" });
    const body = await response.json() as {
      data?: { users?: Array<{ suspended: boolean }> };
    };

    expect(response.status).toBe(200);
    expect(body.data?.users?.[0]?.suspended).toBe(true);
  });

  it("projects truthful pending, expired, and failed invitation states", async () => {
    const baseAdmin = {
      emailVerified: true,
      image: null,
      twoFactorEnabled: false,
      mustChangePassword: true,
      mustEnrollTwoFactor: true,
      banned: false,
      banExpires: null,
      invitationStatus: "pending" as const,
      isSuperAdmin: false,
      createdAt: 1,
    };
    const db = createAdminUserListDbMock({
      adminUsers: [
        {
          ...baseAdmin,
          id: "pending_admin",
          name: "Pending Admin",
          email: "pending@example.com",
          invitationId: "invite_pending",
          invitationDeliveryStatus: "sent",
          invitationExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
          invitationLastSentAt: new Date(),
        },
        {
          ...baseAdmin,
          id: "expired_admin",
          name: "Expired Admin",
          email: "expired@example.com",
          invitationId: "invite_expired",
          invitationDeliveryStatus: "sent",
          invitationExpiresAt: new Date(Date.now() - 1_000),
          invitationLastSentAt: new Date(Date.now() - 61 * 60 * 1000),
        },
        {
          ...baseAdmin,
          id: "failed_admin",
          name: "Failed Admin",
          email: "failed@example.com",
          invitationId: "invite_failed",
          invitationDeliveryStatus: "failed",
          invitationExpiresAt: null,
          invitationLastSentAt: null,
        },
      ],
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/users", { method: "GET" });
    const body = await response.json() as {
      data?: { users?: Array<{ id: string; invitation: { status: string } | null }> };
    };

    expect(response.status).toBe(200);
    expect(body.data?.users?.map(({ id, invitation }) => ({
      id,
      status: invitation?.status,
    }))).toEqual([
      { id: "pending_admin", status: "pending" },
      { id: "expired_admin", status: "expired" },
      { id: "failed_admin", status: "delivery_failed" },
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
    expect(db.batch).toHaveBeenCalledOnce();
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

  it("preserves completed administrator identities for suspension instead of hard deletion", async () => {
    const db = createAdminDeleteDbMock({
      targetUser: {
        id: "ready_admin",
        role: "admin",
        isSuperAdmin: false,
        mustChangePassword: false,
        invitationId: "invite_ready",
        invitationStatus: "accepted",
      },
      targetPrincipalRows: [{ id: "ready_admin" }],
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/users/ready_admin", {
      method: "DELETE",
    });

    expect(response.status).toBe(400);
    expect(db.__deleteWhere).not.toHaveBeenCalled();
  });
});

describe("admin auth management suspension lifecycle", () => {
  it("does not count unfinished invitations as lockout-safe administrators", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "auth-management.ts"),
      "utf8",
    );

    expect(source).toContain("eq(user.mustChangePassword, false)");
    expect(source).toContain("other_admin.must_change_password");
    expect(source).toContain("other_admin.must_enroll_two_factor");
    expect(source).toContain("other_admin.two_factor_enabled");
  });

  it("suspends an administrator and revokes every active session atomically", async () => {
    const db = createAdminSuspensionDbMock();
    const app = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/auth/users/admin_2/suspension",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended: true }),
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      banned: true,
      banReason: "Store access suspended by an administrator",
      banExpires: null,
    }));
    expect(db.__deleteWhere).toHaveBeenCalledOnce();
    expect(db.__batch).toHaveBeenCalledOnce();
  });

  it("blocks suspension when it would remove the last active administrator", async () => {
    const db = createAdminSuspensionDbMock({ otherActiveAdminRows: [] });
    const app = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/auth/users/admin_2/suspension",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended: true }),
      },
    );

    expect(response.status).toBe(400);
    expect(db.__batch).not.toHaveBeenCalled();
  });

  it("reactivates a suspended administrator without changing roles", async () => {
    const db = createAdminSuspensionDbMock({
      target: { id: "admin_2", isSuperAdmin: false, banned: true },
    });
    const app = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/auth/users/admin_2/suspension",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended: false }),
      },
    );

    expect(response.status).toBe(200);
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      banned: false,
      banReason: null,
      banExpires: null,
    }));
    expect(db.__batch).not.toHaveBeenCalled();
  });

  it("turns a concurrent authority change into a retryable conflict", async () => {
    const db = createAdminSuspensionDbMock({
      batchError: new Error("malformed JSON"),
    });
    const app = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/auth/users/admin_2/suspension",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended: true }),
      },
    );

    expect(response.status).toBe(409);
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
    expect(db.__insertValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: "new_admin",
      invitedByUserId: "user_1",
      name: "Ops Admin",
      email: "ops@example.com",
      status: "pending",
      deliveryStatus: "pending",
    }));
    expect(db.__batch).toHaveBeenCalledOnce();
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

  it("rejects assigning the Super Admin role unless the caller is the store owner", async () => {
    const db = createAdminInviteDbMock({
      role: { id: "role_super_admin", name: "super_admin" },
    });
    const signUpEmail = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: { signUpEmail, requestPasswordReset: vi.fn() },
    });
    const app = createTestApp(db, {
      adminPermissions: new Set(["team.manage", "team.manage_roles"]),
      user: { isSuperAdmin: false },
    });

    const response = await app.request("/api/v1/admin/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Escalated Admin",
        email: "escalated@example.com",
        roleId: "role_super_admin",
      }),
    }, { BETTER_AUTH_URL: "https://admin.scalius.test" } as never);

    expect(response.status).toBe(403);
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(mocks.assignRoleToUser).not.toHaveBeenCalled();
  });

  it("lets team managers assign a role contained within their own authority", async () => {
    const db = createAdminInviteDbMock({
      rolePermissions: ["products.view"],
    });
    const signUpEmail = vi.fn().mockResolvedValue({ user: { id: "new_admin" } });
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail,
        requestPasswordReset: vi.fn().mockResolvedValue({ status: true }),
      },
    });
    const app = createTestApp(db, {
      adminPermissions: new Set(["team.manage", "products.view"]),
    });

    const response = await app.request("/api/v1/admin/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Catalog Viewer",
        email: "catalog-viewer@example.com",
        roleId: "role_1",
      }),
    }, { BETTER_AUTH_URL: "https://admin.scalius.test" } as never);

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.assignRoleToUser).toHaveBeenCalledWith(
      db,
      "new_admin",
      "role_1",
      "user_1",
      undefined,
    );
  });

  it("rejects a role containing permissions the inviting manager does not have", async () => {
    const db = createAdminInviteDbMock({
      rolePermissions: ["products.view", "team.manage_roles"],
    });
    const signUpEmail = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: { signUpEmail, requestPasswordReset: vi.fn() },
    });
    const app = createTestApp(db, {
      adminPermissions: new Set(["team.manage", "products.view"]),
    });

    const response = await app.request("/api/v1/admin/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Over-privileged Admin",
        email: "over-privileged@example.com",
        roleId: "role_1",
      }),
    }, { BETTER_AUTH_URL: "https://admin.scalius.test" } as never);

    expect(response.status).toBe(403);
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(mocks.assignRoleToUser).not.toHaveBeenCalled();
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

  it("resends a one-use setup link only while password setup is pending", async () => {
    const db = createAdminResendSetupDbMock();
    const requestPasswordReset = vi.fn().mockResolvedValue({ status: true });
    mocks.createAuth.mockReturnValue({ api: { requestPasswordReset } });
    const app = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/auth/users/pending_admin/resend-setup",
      { method: "POST" },
      { BETTER_AUTH_URL: "https://admin.scalius.test" } as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(requestPasswordReset).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: {
        email: "pending@example.com",
        redirectTo: "/auth/reset-password",
      },
    });
    expect(await response.json()).toEqual({
      success: true,
      data: { message: "A new secure setup link was sent" },
    });
  });

  it("rejects setup-link resend after password setup is complete", async () => {
    const db = createAdminResendSetupDbMock({
      target: {
        id: "ready_admin",
        email: "ready@example.com",
        mustChangePassword: false,
        invitationId: "invite_ready",
        invitationStatus: "accepted",
      },
      principalRows: [{ id: "ready_admin" }],
    });
    const requestPasswordReset = vi.fn();
    mocks.createAuth.mockReturnValue({ api: { requestPasswordReset } });
    const app = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/auth/users/ready_admin/resend-setup",
      { method: "POST" },
      { BETTER_AUTH_URL: "https://admin.scalius.test" } as never,
    );

    expect(response.status).toBe(400);
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("records setup-link delivery failure for an invited administrator", async () => {
    const db = createAdminResendSetupDbMock();
    const requestPasswordReset = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    mocks.createAuth.mockReturnValue({ api: { requestPasswordReset } });
    const app = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/auth/users/pending_admin/resend-setup",
      { method: "POST" },
      { BETTER_AUTH_URL: "https://admin.scalius.test" } as never,
    );

    expect(response.status).toBe(503);
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStatus: "failed",
      expiresAt: null,
    }));
  });
});

describe("admin auth management 2FA method changes", () => {
  it("stages a password-proven TOTP replacement without mutating current authority", async () => {
    const db = createTwoFactorMethodChallengeDbMock();
    const verifyPassword = vi.fn().mockResolvedValue({ status: true });
    mocks.createAuth.mockReturnValue({ api: { verifyPassword } });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method-challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "totp", password: "correct password" }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(verifyPassword).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { password: "correct password" },
    });
    expect(mocks.createPendingTotpMethodChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        authSecret: TEST_ACCOUNT_SESSION_COMMAND_SECRET,
        userId: "user_1",
        sessionId: "session_1",
        email: "admin@example.com",
      }),
    );
    expect(db.__insertedValues).toEqual([
      expect.objectContaining({
        id: "tfmc_0123456789abcdef0123456789abcdef",
        identifier: "admin:2fa-method:user_1:session_1",
        value: "encrypted-challenge-value",
      }),
    ]);
    expect(db.__updateSets).toEqual([]);
    expect(db.__batch).toHaveBeenCalledTimes(1);
  });

  it("commits staged TOTP secret, recovery codes, method, and session before consuming the challenge", async () => {
    const db = createTwoFactorMethodChallengeDbMock();
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "totp",
          challengeId: "tfmc_0123456789abcdef0123456789abcdef",
          code: "123456",
        }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );
    const body = await response.json() as { data?: { backupCodes?: string[] } };

    expect(response.status).toBe(200);
    expect(mocks.verifyPendingTotpCode).toHaveBeenCalledWith(
      "pending-raw-secret-with-enough-length",
      "123456",
    );
    expect(db.__updateSets).toEqual([
      expect.objectContaining({
        secret: "encrypted-pending-secret",
        backupCodes: "encrypted-stored-backup-codes",
        verified: true,
      }),
      expect.objectContaining({
        twoFactorEnabled: true,
        twoFactorMethod: "totp",
        mustEnrollTwoFactor: false,
      }),
      expect.objectContaining({ twoFactorVerified: true }),
    ]);
    expect(db.__batch).toHaveBeenCalledTimes(1);
    expect(body.data?.backupCodes).toEqual([
      "one", "two", "three", "four", "five",
      "six", "seven", "eight", "nine", "ten",
    ]);
  });

  it("stages a password-proven email replacement without touching recovery authority", async () => {
    const db = createTwoFactorMethodChallengeDbMock();
    const verifyPassword = vi.fn().mockResolvedValue({ status: true });
    mocks.createAuth.mockReturnValue({ api: { verifyPassword } });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
      user: { twoFactorMethod: "totp", mustEnrollTwoFactor: false },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method-challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "email", password: "correct password" }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );
    const body = await response.json() as { data?: { totpUri?: string | null } };

    expect(response.status).toBe(200);
    expect(mocks.createPendingEmailMethodChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        authSecret: TEST_ACCOUNT_SESSION_COMMAND_SECRET,
        userId: "user_1",
        sessionId: "session_1",
      }),
    );
    expect(body.data?.totpUri).toBeNull();
    expect(db.__updateSets).toEqual([]);
  });

  it("atomically consumes a password-bound challenge after email OTP verification", async () => {
    const db = createTwoFactorMethodChallengeDbMock({ batchChanges: [1, 1, 1, 1] });
    mocks.readPendingTwoFactorMethodChallenge.mockResolvedValueOnce({
      version: 1,
      userId: "user_1",
      sessionId: "session_1",
      method: "email",
      expiresAt: Date.now() + 600_000,
    });
    const verifyTwoFactorOTP = vi.fn().mockResolvedValue({
      response: { token: "verified_session_token" },
      headers: new Headers(),
    });
    mocks.createAuth.mockReturnValue({ api: { verifyTwoFactorOTP } });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
      user: { twoFactorMethod: "totp", mustEnrollTwoFactor: false },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "email",
          challengeId: "tfmc_0123456789abcdef0123456789abcdef",
          code: "123456",
        }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(verifyTwoFactorOTP).toHaveBeenCalledTimes(1);
    expect(db.__updateSets).toEqual([
      expect.objectContaining({
        twoFactorEnabled: true,
        twoFactorMethod: "email",
        mustEnrollTwoFactor: false,
      }),
      expect.objectContaining({ twoFactorVerified: true }),
    ]);
    expect(db.__batch).toHaveBeenCalledTimes(1);
  });

  it("leaves current method authority untouched when a staged challenge is abandoned", async () => {
    const db = createTwoFactorMethodChallengeDbMock();
    mocks.createAuth.mockReturnValue({
      api: { verifyPassword: vi.fn().mockResolvedValue({ status: true }) },
    });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method-challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "totp", password: "correct password" }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect(response.status).toBe(200);
    expect(db.__updateSets).toEqual([]);
    expect(mocks.readPendingTwoFactorMethodChallenge).not.toHaveBeenCalled();
  });

  it("rejects expired staged challenges before any authority update", async () => {
    const db = createTwoFactorMethodChallengeDbMock({ challengeRows: [null] });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "totp",
          challengeId: "tfmc_0123456789abcdef0123456789abcdef",
          code: "123456",
        }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect(response.status).toBe(400);
    expect(db.__updateSets).toEqual([]);
    expect(db.__batch).not.toHaveBeenCalled();
    expect(mocks.createAuth).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous existing two-factor authority before commit", async () => {
    const db = createTwoFactorMethodChallengeDbMock({ duplicateTwoFactor: true });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "totp",
          challengeId: "tfmc_0123456789abcdef0123456789abcdef",
          code: "123456",
        }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect(response.status).toBe(409);
    expect(db.__updateSets).toEqual([]);
    expect(db.__batch).not.toHaveBeenCalled();
  });

  it("fails a concurrent replay after the one-time challenge is consumed", async () => {
    const db = createTwoFactorMethodChallengeDbMock({
      challengeRows: [{ value: "encrypted-challenge-value" }, null],
    });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });
    const request = () => app.request(
      "/api/v1/admin/auth/2fa/method",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "totp",
          challengeId: "tfmc_0123456789abcdef0123456789abcdef",
          code: "123456",
        }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(400);
    expect(db.__batch).toHaveBeenCalledTimes(1);
  });

  it("maps a transactional guard abort to a stale-challenge conflict", async () => {
    const db = createTwoFactorMethodChallengeDbMock({
      batchError: new Error("malformed JSON"),
    });
    const app = createTestApp(db, {
      twoFactorEnabled: true,
      session: { id: "session_1", twoFactorVerified: true },
    });

    const response = await app.request(
      "/api/v1/admin/auth/2fa/method",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "totp",
          challengeId: "tfmc_0123456789abcdef0123456789abcdef",
          code: "123456",
        }),
      },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect(response.status).toBe(409);
  });

  it("rejects session-token possession as an enrollment proof", async () => {
    const db = createDbMock();
    const app = createTestApp(db, {
      twoFactorEnabled: false,
      session: { id: "session_1", twoFactorVerified: false },
      user: { mustEnrollTwoFactor: true },
    });

    const response = await app.request("/api/v1/admin/auth/2fa/method", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "email",
        sessionToken: "same_origin_verified_session_token_123456789",
      }),
    });

    expect(response.status).toBe(400);
    expect(mocks.createAuth).not.toHaveBeenCalled();
    expect(db.__updateSet).not.toHaveBeenCalled();
  });

  it("verifies the target method code before updating the preferred 2FA method", async () => {
    const db = createDbMock({ sessionToken: "verified_session_token" });
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
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorVerified: true,
    }));
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorEnabled: true,
      twoFactorMethod: "email",
      mustEnrollTwoFactor: false,
    }));
  });

  it("uses the rotated session cookie when first-time TOTP verification returns a stale token", async () => {
    const db = createDbMock({ sessionToken: "new_session_token" });
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
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorVerified: true,
    }));
    expect(db.__updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorEnabled: true,
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

describe("admin account session lifecycle", () => {
  it("lists only sanitized session presentation data and identifies the current session", async () => {
    const db = createAccountSessionsDbMock();
    const app = createTestApp(db);
    const currentCommandId = await getTestAccountSessionCommandId("session_1");
    const otherCommandId = await getTestAccountSessionCommandId("session_2");

    const response = await app.request("/api/v1/admin/auth/sessions", {
      method: "GET",
    }, TEST_ACCOUNT_SESSION_ENV);

    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      data?: {
        sessions?: Array<Record<string, unknown>>;
        hasMore?: boolean;
      };
    };
    expect(body.data?.sessions).toEqual([
      expect.objectContaining({
        commandId: currentCommandId,
        current: true,
        deviceLabel: "Chrome on macOS",
        networkHint: "203.0.113.x",
      }),
      expect.objectContaining({
        commandId: otherCommandId,
        current: false,
        deviceLabel: "Safari on iPhone",
        networkHint: "2001:db8:abcd:…",
      }),
    ]);
    expect(body.data?.hasMore).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Mozilla");
    expect(JSON.stringify(body)).not.toContain("203.0.113.42");
    expect(JSON.stringify(body)).not.toContain("raw_session_token");
    expect(JSON.stringify(body)).not.toContain("session_1");
    expect(JSON.stringify(body)).not.toContain("session_2");
  });

  it("bounds the visible list while reporting hidden active sessions", async () => {
    const otherSessions = Array.from({ length: 25 }, (_, index) => ({
      id: `session_${index + 2}`,
      token: `token_${index + 2}`,
      ipAddress: null,
      userAgent: null,
      impersonatedBy: null,
      twoFactorVerified: true,
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
      expiresAt: new Date("2026-07-20T10:00:00.000Z"),
    }));
    const db = createAccountSessionsDbMock({ otherSessions });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/sessions", {
      method: "GET",
    }, TEST_ACCOUNT_SESSION_ENV);
    const body = (await response.json()) as {
      data?: { sessions?: unknown[]; hasMore?: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.data?.sessions).toHaveLength(25);
    expect(body.data?.hasMore).toBe(true);
    expect(JSON.stringify(body)).not.toContain("token_");
  });

  it("fails closed when the middleware session is no longer active in D1", async () => {
    const db = createAccountSessionsDbMock({ currentSession: null });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/sessions", {
      method: "GET",
    }, TEST_ACCOUNT_SESSION_ENV);
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("revokes an owned non-current session", async () => {
    const db = createAccountSessionsDbMock({
      revokedSessionIds: ["session_2"],
    });
    const app = createTestApp(db);
    const commandId = await getTestAccountSessionCommandId("session_2");

    const response = await app.request(
      `/api/v1/admin/auth/sessions/${commandId}`,
      { method: "DELETE" },
      TEST_ACCOUNT_SESSION_ENV,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(db.__deleteReturning).toHaveBeenCalledOnce();
  });

  it("cannot revoke the current session through device management", async () => {
    const db = createAccountSessionsDbMock();
    const app = createTestApp(db);
    const commandId = await getTestAccountSessionCommandId("session_1");

    const response = await app.request(
      `/api/v1/admin/auth/sessions/${commandId}`,
      { method: "DELETE" },
      TEST_ACCOUNT_SESSION_ENV,
    );
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(db.__deleteWhere).not.toHaveBeenCalled();
  });

  it("does not reveal whether a session belongs to another account", async () => {
    const db = createAccountSessionsDbMock({ revokedSessionIds: [] });
    const app = createTestApp(db);
    const commandId = await getTestAccountSessionCommandId(
      "session_from_another_user",
    );

    const response = await app.request(
      `/api/v1/admin/auth/sessions/${commandId}`,
      { method: "DELETE" },
      TEST_ACCOUNT_SESSION_ENV,
    );
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(db.__deleteWhere).not.toHaveBeenCalled();
  });

  it("fails closed before revocation when the current D1 session is gone", async () => {
    const db = createAccountSessionsDbMock({ currentSession: null });
    const app = createTestApp(db);
    const commandId = await getTestAccountSessionCommandId("session_2");

    const response = await app.request(
      `/api/v1/admin/auth/sessions/${commandId}`,
      { method: "DELETE" },
      TEST_ACCOUNT_SESSION_ENV,
    );
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(db.__deleteWhere).not.toHaveBeenCalled();
  });

  it("revokes every other owned session while preserving the current session", async () => {
    const db = createAccountSessionsDbMock({
      revokedSessionIds: ["session_2", "session_3"],
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/sessions", {
      method: "DELETE",
    }, TEST_ACCOUNT_SESSION_ENV);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      data?: { revokedCount?: number };
    };

    expect(body.data?.revokedCount).toBe(2);
    expect(db.__deleteReturning).toHaveBeenCalledOnce();
  });

  it("preserves the last active current session", async () => {
    const db = createAccountSessionsDbMock({
      otherSessions: [],
      revokedSessionIds: [],
    });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/sessions", {
      method: "DELETE",
    }, TEST_ACCOUNT_SESSION_ENV);
    const body = (await response.json()) as {
      data?: { revokedCount?: number; message?: string };
    };

    expect(response.status).toBe(200);
    expect(body.data?.revokedCount).toBe(0);
    expect(body.data?.message).toBe("No other active sessions were found");
  });

  it("fails closed when the command identity secret is unavailable", async () => {
    const db = createAccountSessionsDbMock();
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/sessions", {
      method: "GET",
    });
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("SERVICE_UNAVAILABLE");
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
  it("treats RBAC-only admin principals as bootstrapped for setup checks", async () => {
    const db = createSetupDbMock({ adminExistsResult: { found: 1 } });
    const signUpEmail = vi.fn();
    mocks.createAuth.mockReturnValue({
      api: {
        signUpEmail,
      },
    });
    const app = createSetupTestApp(db);

    const statusResponse = await app.request("/api/v1/setup", {
      method: "GET",
    }, {});
    const statusBody = await statusResponse.json() as { data?: { adminExists?: boolean } };
    expect(statusResponse.status).toBe(200);
    expect(statusBody.data?.adminExists).toBe(true);

    const setupResponse = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: setupRequestBody(),
    }, {});

    expect(setupResponse.status).toBe(403);
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(mocks.enforceAdminSetupRateLimit).not.toHaveBeenCalled();
    expect(mocks.claimAdminSetup).not.toHaveBeenCalled();
    const query = new SQLiteSyncDialect().sqlToQuery(
      db.__adminExistsGet.mock.calls[0]?.[0] as SQL,
    ).sql;
    expect(query).not.toContain("admin_user.role = 'admin'");
    expect(query).toContain("from user_roles");
    expect(query).toContain("inner join role_permissions");
    expect(query).toContain("from user_permissions as granted_permissions");
    expect(query).toContain("granted_permissions.granted = 1");
  });

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
