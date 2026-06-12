import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  SCANNER_COOKIE_NAME,
  getScannerSessionKey,
  type ScannerSessionPayload,
} from "@scalius/shared/scanner-auth";

const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  getUserPermissions: vi.fn(),
}));

vi.mock("@scalius/core/auth", () => ({
  getAuth: mocks.getAuth,
}));

vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  getUserPermissions: mocks.getUserPermissions,
}));

import { adminAuthMiddleware } from "./admin-auth";

function mockBetterAuthSession(
  overrides: {
    user?: Record<string, unknown>;
    session?: Record<string, unknown>;
  } = {},
) {
  mocks.getAuth.mockReturnValue({
    api: {
      getSession: vi.fn().mockResolvedValue({
        session: {
          id: "session_1",
          twoFactorVerified: true,
          ...overrides.session,
        },
        user: {
          id: "admin_1",
          email: "admin@example.com",
          name: "Admin",
          role: "admin",
          twoFactorEnabled: false,
          ...overrides.user,
        },
      }),
    },
  });
}

function createContext(
  pathname: string,
  method = "GET",
  options: { headers?: HeadersInit; env?: Record<string, unknown> } = {},
) {
  const request = new Request(`https://api.scalius.test${pathname}`, {
    method,
    headers: options.headers,
  });

  return {
    env: options.env ?? {},
    req: {
      raw: request,
      url: request.url,
      path: pathname,
      method,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    set: vi.fn(),
    get: vi.fn((key: string) => (key === "db" ? { id: "db" } : undefined)),
    header: vi.fn(),
  };
}

describe("adminAuthMiddleware RBAC route mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockBetterAuthSession();
  });

  it("allows a mapped admin route when the user has the required permission", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.PRODUCTS_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(createContext("/api/v1/admin/products") as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("stores the Better Auth session on the Hono context", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.PRODUCTS_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);
    const context = createContext("/api/v1/admin/products");

    await adminAuthMiddleware(context as never, next);

    expect(context.set).toHaveBeenCalledWith(
      "session",
      expect.objectContaining({ id: "session_1", twoFactorVerified: true }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects an admin API request when the session has not completed 2FA", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: false },
    });
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.PRODUCTS_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(createContext("/api/v1/admin/products") as never, next),
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
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.PRODUCTS_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(createContext("/api/v1/admin/products") as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows exact 2FA completion endpoints before the session is marked verified", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: false },
    });
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.DASHBOARD_VIEW]));

    for (const [pathname, method] of [
      ["/api/v1/admin/auth/2fa/info", "GET"],
      ["/api/v1/admin/auth/2fa/verify", "POST"],
      ["/api/v1/admin/auth/2fa/mark-verified", "POST"],
    ] as const) {
      const next = vi.fn().mockResolvedValue(undefined);
      await adminAuthMiddleware(createContext(pathname, method) as never, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("does not allow broader 2FA management endpoints before verification", async () => {
    mockBetterAuthSession({
      user: { twoFactorEnabled: true },
      session: { twoFactorVerified: false },
    });
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.DASHBOARD_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(createContext("/api/v1/admin/auth/2fa/method", "POST") as never, next),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Two-factor verification required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed for an unmapped admin route even when the user has admin permissions", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.DASHBOARD_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(createContext("/api/v1/admin/not-a-real-route") as never, next),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "This admin endpoint is not configured for RBAC",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("still rejects mapped routes when the user lacks the required permission", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.DASHBOARD_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(createContext("/api/v1/admin/products") as never, next),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("requires the dedicated refund permission for direct refund endpoints", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.ORDERS_EDIT]));
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(createContext("/api/v1/admin/orders/order_1/refund", "POST") as never, next),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });

    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.ORDERS_REFUND]));
    await adminAuthMiddleware(createContext("/api/v1/admin/orders/order_1/refund", "POST") as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("requires product view permission for navigation product previews", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.SETTINGS_HEADER_EDIT]));
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/navigation/preview-products", "GET") as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });

    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.PRODUCTS_VIEW]));
    await adminAuthMiddleware(
      createContext("/api/v1/admin/navigation/preview-products", "GET") as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows scanner sessions only on exact scanner workflow endpoints", async () => {
    mocks.getAuth.mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    });
    const sessionId = "scanner-session";
    const session: ScannerSessionPayload = {
      adminId: "admin_1",
      adminName: "Warehouse",
      createdAt: Date.now(),
    };
    const sessionKey = await getScannerSessionKey(sessionId);
    const kv = {
      get: vi.fn().mockImplementation((key: string) =>
        Promise.resolve(key === sessionKey ? JSON.stringify(session) : null),
      ),
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(
      createContext("/api/v1/admin/inventory/scanner/lookup?code=ABC", "GET", {
        headers: { Cookie: `${SCANNER_COOKIE_NAME}=${encodeURIComponent(sessionId)}` },
        env: { CACHE: kv },
      }) as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
  });

  it("rejects scanner sessions on broader inventory endpoints", async () => {
    mocks.getAuth.mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    });
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
          headers: { Cookie: `${SCANNER_COOKIE_NAME}=${encodeURIComponent(sessionId)}` },
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
    mocks.getAuth.mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      adminAuthMiddleware(
        createContext("/api/v1/admin/inventory/scanner/lookup?code=ABC", "GET", {
          headers: { "X-Scanner-Token": "raw-qr-token" },
          env: { CACHE: { get: vi.fn().mockResolvedValue(null) } },
        }) as never,
        next,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
