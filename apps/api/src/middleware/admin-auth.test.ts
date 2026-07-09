import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  SCANNER_COOKIE_NAME,
  getScannerSessionKey,
  type ScannerSessionPayload,
} from "@scalius/shared/scanner-auth";

const mocks = vi.hoisted(() => ({
  autoSeedRbacIfNeeded: vi.fn(),
  getUserPermissions: vi.fn(),
}));

vi.mock("@scalius/core/auth/rbac/auto-seed", () => ({
  autoSeedRbacIfNeeded: mocks.autoSeedRbacIfNeeded,
}));

vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  getUserPermissions: mocks.getUserPermissions,
}));

import { adminAuthMiddleware } from "./admin-auth";

const TEST_SECRET = "test-secret";
let currentAuthUser: Record<string, unknown> = {};
let currentAuthSession: Record<string, unknown> = {};

function mockBetterAuthSession(
  overrides: {
    user?: Record<string, unknown>;
    session?: Record<string, unknown>;
  } = {},
) {
  currentAuthUser = {
    id: "admin_1",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    twoFactorEnabled: false,
    ...overrides.user,
  };
  currentAuthSession = {
    id: "session_1",
    twoFactorVerified: true,
    ...overrides.session,
  };
}

function signTestCookieValue(value: string): string {
  const signature = createHmac("sha256", TEST_SECRET)
    .update(value)
    .digest("base64");
  return `${value}.${signature}`;
}

function createDbMock(liveUser: Record<string, unknown> = {}) {
  const row = {
    id: currentAuthUser.id ?? "admin_1",
    email: currentAuthUser.email ?? "admin@example.com",
    name: currentAuthUser.name ?? "Admin",
    role: currentAuthUser.role ?? "admin",
    isSuperAdmin: currentAuthUser.isSuperAdmin ?? false,
    twoFactorEnabled: currentAuthUser.twoFactorEnabled ?? false,
    mustChangePassword: currentAuthUser.mustChangePassword ?? false,
    mustEnrollTwoFactor: currentAuthUser.mustEnrollTwoFactor ?? false,
    sessionId: currentAuthSession.id ?? "session_1",
    twoFactorVerified: currentAuthSession.twoFactorVerified ?? true,
    ...liveUser,
  };
  return {
    id: "db",
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => row),
          })),
        })),
      })),
    })),
  };
}

function createContext(
  pathname: string,
  method = "GET",
  options: {
    headers?: HeadersInit;
    env?: Record<string, unknown>;
    db?: unknown;
    liveUser?: Record<string, unknown>;
  } = {},
) {
  const headers = options.headers ?? {
    Cookie: `better-auth.session_token=${encodeURIComponent(signTestCookieValue("test_session"))}`,
  };
  const request = new Request(`https://api.scalius.test${pathname}`, {
    method,
    headers,
  });
  const db = options.db ?? createDbMock(options.liveUser);

  return {
    req: {
      raw: request,
      url: request.url,
      path: pathname,
      method,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    set: vi.fn(),
    get: vi.fn((key: string) => (key === "db" ? db : undefined)),
    header: vi.fn(),
    env: { BETTER_AUTH_SECRET: TEST_SECRET, ...(options.env ?? {}) },
  };
}

describe("adminAuthMiddleware RBAC route mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.autoSeedRbacIfNeeded.mockResolvedValue(undefined);
    mockBetterAuthSession();
  });

  it("allows a mapped admin route when the user has the required permission", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/products") as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows checkout readiness reads for settings viewers", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.SETTINGS_GENERAL_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/settings/checkout-readiness") as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows SEO feed diagnostic reads for settings viewers", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.SETTINGS_GENERAL_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/settings/seo/feed-diagnostics") as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passes the runtime KV binding into permission resolution", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);
    const cache = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };

    await adminAuthMiddleware(
      createContext("/api/v1/admin/products", "GET", {
        env: { CACHE: cache },
      }) as never,
      next,
    );

    expect(mocks.getUserPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      "admin_1",
      cache,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("synchronizes the RBAC catalog before reading effective permissions", async () => {
    const callOrder: string[] = [];
    mocks.autoSeedRbacIfNeeded.mockImplementation(async () => {
      callOrder.push("seed");
    });
    mocks.getUserPermissions.mockImplementation(async () => {
      callOrder.push("permissions");
      return new Set([PERMISSIONS.PRODUCTS_VIEW]);
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const cache = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const context = createContext("/api/v1/admin/products", "GET", {
      env: { CACHE: cache },
    });

    await adminAuthMiddleware(context as never, next);

    expect(mocks.autoSeedRbacIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      cache,
    );
    expect(callOrder).toEqual(["seed", "permissions"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("publishes the exact effective permission snapshot to downstream authority routes", async () => {
    const effectivePermissions = new Set([PERMISSIONS.PRODUCTS_VIEW]);
    mocks.getUserPermissions.mockResolvedValue(effectivePermissions);
    const next = vi.fn().mockResolvedValue(undefined);
    const context = createContext("/api/v1/admin/products");

    await adminAuthMiddleware(context as never, next);

    expect(context.set).toHaveBeenCalledWith(
      "adminPermissions",
      effectivePermissions,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary admin session checks on the direct signed-cookie path", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./admin-auth.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("verifyBetterAuthSignedCookieValue");
    expect(source).not.toContain("getAuth(");
    expect(source).not.toContain("auth.api.getSession");
  });

  it("allows own-account endpoints for any verified admin with admin access", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/auth/account-security", "GET") as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows team viewing separately from team mutation", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.TEAM_VIEW]),
    );

    const listNext = vi.fn().mockResolvedValue(undefined);
    await adminAuthMiddleware(
      createContext("/api/v1/admin/auth/users", "GET") as never,
      listNext,
    );
    expect(listNext).toHaveBeenCalledTimes(1);

    const createNext = vi.fn().mockResolvedValue(undefined);
    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/auth/users", "POST") as never,
        createNext,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(createNext).not.toHaveBeenCalled();

    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.TEAM_MANAGE]),
    );
    await adminAuthMiddleware(
      createContext("/api/v1/admin/auth/users", "POST") as never,
      createNext,
    );
    expect(createNext).toHaveBeenCalledTimes(1);
  });

  it("stores the Better Auth session on the Hono context", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);
    const context = createContext("/api/v1/admin/products");

    await adminAuthMiddleware(context as never, next);

    expect(context.set).toHaveBeenCalledWith(
      "session",
      expect.objectContaining({ id: "session_1", twoFactorVerified: true }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects Bearer-only admin API requests instead of trusting JWT claims", async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const context = createContext("/api/v1/admin/products", "GET", {
      headers: { Authorization: "Bearer valid-looking-admin-jwt" },
    });

    await expect(
      adminAuthMiddleware(context as never, next),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Admin access requires a valid dashboard session cookie.",
    });
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(context.header).not.toHaveBeenCalledWith(
      "X-New-Token",
      expect.any(String),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects no-cookie admin API requests before Better Auth or RBAC work", async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const context = createContext("/api/v1/admin/orders", "GET", {
      headers: {},
    });

    await expect(
      adminAuthMiddleware(context as never, next),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Admin access requires a valid dashboard session cookie.",
    });
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects raw or tampered Better Auth cookies before D1/RBAC work", async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const db = createDbMock();

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/orders", "GET", {
          headers: { Cookie: "better-auth.session_token=test_session" },
          db,
        }) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/orders", "GET", {
          headers: { Cookie: `better-auth.session_token=${encodeURIComponent(signTestCookieValue("test_session"))}tampered` },
          db,
        }) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });

    expect(db.select).not.toHaveBeenCalled();
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects password-onboarding admins before RBAC", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/products", "GET", {
          liveUser: { mustChangePassword: true },
        }) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Password setup required before admin access",
    });

    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("allows only the password-change endpoint while password onboarding is pending", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.DASHBOARD_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/auth/change-password", "POST", {
        liveUser: { mustChangePassword: true },
      }) as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects 2FA-onboarding admins before RBAC except setup endpoints", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.DASHBOARD_VIEW]),
    );
    const blockedNext = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/products", "GET", {
          liveUser: { mustEnrollTwoFactor: true, twoFactorEnabled: false },
        }) as never,
        blockedNext,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Two-factor setup required before admin access",
    });
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(blockedNext).not.toHaveBeenCalled();

    for (const [pathname, method] of [
      ["/api/v1/admin/auth/2fa/info", "GET"],
      ["/api/v1/admin/auth/2fa/method", "POST"],
    ] as const) {
      mocks.getUserPermissions.mockResolvedValue(
        new Set([PERMISSIONS.DASHBOARD_VIEW]),
      );
      const next = vi.fn().mockResolvedValue(undefined);
      await adminAuthMiddleware(
        createContext(pathname, method, {
          liveUser: { mustEnrollTwoFactor: true, twoFactorEnabled: false },
        }) as never,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects an admin API request when the session has not completed 2FA", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: false },
    });
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/products") as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Two-factor verification required",
    });
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("allows admin API requests after 2FA is verified", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: true },
    });
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/products") as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows exact 2FA completion endpoints before the session is marked verified", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: false },
    });
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.DASHBOARD_VIEW]),
    );

    for (const [pathname, method] of [
      ["/api/v1/admin/auth/2fa/info", "GET"],
      ["/api/v1/admin/auth/2fa/verify", "POST"],
      ["/api/v1/admin/auth/2fa/complete-verification", "POST"],
      ["/api/v1/admin/auth/2fa/method", "POST"],
    ] as const) {
      const next = vi.fn().mockResolvedValue(undefined);
      await adminAuthMiddleware(createContext(pathname, method) as never, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("does not allow direct 2FA mark-verified requests before proof verification", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: false },
    });
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.DASHBOARD_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/auth/2fa/mark-verified", "POST") as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Two-factor verification required",
    });
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("does not allow broader 2FA management endpoints before verification", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: false },
    });
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.DASHBOARD_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/auth/account-security", "GET") as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Two-factor verification required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed for an unmapped admin route even when the user has admin permissions", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.DASHBOARD_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/not-a-real-route") as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "This admin endpoint is not configured for RBAC",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("still rejects mapped routes when the user lacks the required permission", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.DASHBOARD_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/products") as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("requires the dedicated refund permission for direct refund and recovery endpoints", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.ORDERS_EDIT]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/orders/order_1/refund", "POST") as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    await expect(
      adminAuthMiddleware(
        createContext(
          "/api/v1/admin/orders/order_1/refund-attempts/rfa_1/reconcile",
          "POST",
        ) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });

    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.ORDERS_REFUND]),
    );
    await adminAuthMiddleware(
      createContext("/api/v1/admin/orders/order_1/refund", "POST") as never,
      next,
    );
    await adminAuthMiddleware(
      createContext(
        "/api/v1/admin/orders/order_1/refund-attempts/rfa_1/reconcile",
        "POST",
      ) as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("requires product view permission for navigation product previews", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.SETTINGS_HEADER_EDIT]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext(
          "/api/v1/admin/navigation/preview-products",
          "GET",
        ) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });

    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.PRODUCTS_VIEW]),
    );
    await adminAuthMiddleware(
      createContext(
        "/api/v1/admin/navigation/preview-products",
        "GET",
      ) as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("maps deeper Pathao import status to delivery-location edit permission", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext(
          "/api/v1/admin/settings/delivery-locations/import-pathao/status",
          "GET",
        ) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });

    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT]),
    );
    await adminAuthMiddleware(
      createContext(
        "/api/v1/admin/settings/delivery-locations/import-pathao/status",
        "GET",
      ) as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("maps widget generation session status to widget edit permission", async () => {
    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.WIDGETS_VIEW]),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext(
          "/api/v1/admin/widget-generation-runs/sessions/session_1/status",
          "GET",
        ) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });

    mocks.getUserPermissions.mockResolvedValue(
      new Set([PERMISSIONS.WIDGETS_EDIT]),
    );
    await adminAuthMiddleware(
      createContext(
        "/api/v1/admin/widget-generation-runs/sessions/session_1/status",
        "GET",
      ) as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows scanner sessions only on exact scanner workflow endpoints", async () => {
    const sessionId = "scanner-session";
    const session: ScannerSessionPayload = {
      adminId: "admin_1",
      adminName: "Warehouse",
      createdAt: Date.now(),
    };
    const sessionKey = await getScannerSessionKey(sessionId);
    const kv = {
      get: vi
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(key === sessionKey ? JSON.stringify(session) : null),
        ),
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/inventory/scanner/lookup?code=ABC", "GET", {
        headers: {
          Cookie: `${SCANNER_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
        },
        env: { CACHE: kv },
      }) as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
  });

  it("rejects scanner sessions on broader inventory endpoints", async () => {
    const sessionId = "scanner-session";
    const sessionKey = await getScannerSessionKey(sessionId);
    const kv = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          adminId: "admin_1",
          adminName: "Warehouse",
          createdAt: Date.now(),
        } satisfies ScannerSessionPayload),
      ),
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/inventory/variant_1/adjust", "POST", {
          headers: {
            Cookie: `${SCANNER_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
          },
          env: { CACHE: kv },
        }) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Scanner sessions can only access scanner inventory endpoints",
    });
    expect(kv.get).toHaveBeenCalledWith(sessionKey);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not accept raw scanner QR tokens as API credentials", async () => {
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext(
          "/api/v1/admin/inventory/scanner/lookup?code=ABC",
          "GET",
          {
            headers: { "X-Scanner-Token": "raw-qr-token" },
            env: { CACHE: { get: vi.fn().mockResolvedValue(null) } },
          },
        ) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
