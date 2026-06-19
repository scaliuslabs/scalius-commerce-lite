import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: {} as { DB?: unknown },
  retryTransientD1: vi.fn((operation: () => unknown) => operation()),
  initBindings: vi.fn(),
  getAuthSession: vi.fn(),
  getRequestHeader: vi.fn(),
  loadUserPermissions: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

vi.mock("@scalius/core/utils/transient-d1", () => ({
  retryTransientD1: mocks.retryTransientD1,
}));

vi.mock("~/lib/auth.server", () => ({
  initBindings: mocks.initBindings,
  getAuthSession: mocks.getAuthSession,
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: mocks.getRequestHeader,
}));

vi.mock("~/middleware/rbac.server", () => ({
  loadUserPermissions: mocks.loadUserPermissions,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (handler: () => unknown) => handler,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  redirect: (options: unknown) => ({ redirect: options }),
}));

function createAdminExistsDb(counts: number[]) {
  const first = vi.fn(async () => ({ count: counts.shift() ?? 0 }));
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    db: { prepare },
    first,
    bind,
    prepare,
  };
}

describe("admin setup guard cache", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.retryTransientD1.mockImplementation((operation: () => unknown) => operation());
    mocks.getRequestHeader.mockReturnValue("");
    mocks.getAuthSession.mockResolvedValue(null);
    mocks.loadUserPermissions.mockResolvedValue({
      permissions: new Set(),
      isSuperAdmin: false,
      hasAdminAccess: false,
    });
    const { clearAdminExistsCache } = await import("./auth.fns");
    clearAdminExistsCache();
  });

  it("caches successful admin-exists reads for hot auth guards", async () => {
    const db = createAdminExistsDb([1, 0]);
    mocks.cfEnv.DB = db.db;
    const { checkAdminExists } = await import("./auth.fns");

    await expect(checkAdminExists()).resolves.toBe(true);
    await expect(checkAdminExists()).resolves.toBe(true);

    expect(mocks.initBindings).not.toHaveBeenCalled();
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.bind).toHaveBeenCalledWith("admin");
    expect(db.first).toHaveBeenCalledTimes(1);
  });

  it("does not cache a missing admin so first setup can recover immediately", async () => {
    const db = createAdminExistsDb([0, 1]);
    mocks.cfEnv.DB = db.db;
    const { checkAdminExists } = await import("./auth.fns");

    await expect(checkAdminExists()).resolves.toBe(false);
    await expect(checkAdminExists()).resolves.toBe(true);

    expect(db.prepare).toHaveBeenCalledTimes(2);
    expect(db.first).toHaveBeenCalledTimes(2);
  });

  it("expires the hot admin-exists cache after the short isolate TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T00:00:00.000Z"));
    const db = createAdminExistsDb([1, 1]);
    mocks.cfEnv.DB = db.db;
    const { checkAdminExists } = await import("./auth.fns");

    await expect(checkAdminExists()).resolves.toBe(true);

    vi.setSystemTime(new Date("2026-06-19T00:06:00.000Z"));

    await expect(checkAdminExists()).resolves.toBe(true);
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it("passes the fresh Better Auth super-admin value into RBAC loading", async () => {
    const db = createAdminExistsDb([1]);
    mocks.cfEnv.DB = db.db;
    mocks.getRequestHeader.mockReturnValue("better-auth.session_token=token");
    mocks.getAuthSession.mockResolvedValue({
      user: {
        id: "user_1",
        name: "Admin",
        email: "admin@example.com",
        role: "admin",
        image: null,
        twoFactorEnabled: false,
        isSuperAdmin: true,
      },
      session: {
        id: "session_1",
        twoFactorVerified: true,
      },
    });
    mocks.loadUserPermissions.mockResolvedValue({
      permissions: new Set(["orders.read"]),
      isSuperAdmin: true,
      hasAdminAccess: true,
    });
    const { adminRouteGuard } = await import("./auth.fns");

    await expect(adminRouteGuard()).resolves.toMatchObject({
      isSuperAdmin: true,
      permissions: ["orders.read"],
      user: { id: "user_1", isSuperAdmin: true },
    });

    expect(mocks.loadUserPermissions).toHaveBeenCalledWith(
      "user_1",
      "admin",
      true,
    );
  });

  it("returns no session without initializing auth when no cookie is present", async () => {
    const { getSessionInfo } = await import("./auth.fns");

    await expect(getSessionInfo()).resolves.toBeNull();

    expect(mocks.initBindings).not.toHaveBeenCalled();
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
  });

  it("lets the login page render without session lookup when no cookie is present", async () => {
    const db = createAdminExistsDb([1]);
    mocks.cfEnv.DB = db.db;
    const { loginPageGuard } = await import("./auth.fns");

    await expect(loginPageGuard()).resolves.toBeNull();

    expect(mocks.initBindings).not.toHaveBeenCalled();
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
  });

  it("keeps setup recovery ahead of login no-cookie fast path", async () => {
    const db = createAdminExistsDb([0]);
    mocks.cfEnv.DB = db.db;
    const { loginPageGuard } = await import("./auth.fns");

    await expect(loginPageGuard()).rejects.toEqual({
      redirect: { to: "/auth/setup" },
    });

    expect(mocks.initBindings).not.toHaveBeenCalled();
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
  });

  it("redirects anonymous admin requests without session or RBAC reads", async () => {
    const db = createAdminExistsDb([1]);
    mocks.cfEnv.DB = db.db;
    const { adminRouteGuard } = await import("./auth.fns");

    await expect(adminRouteGuard()).rejects.toEqual({
      redirect: { to: "/auth/login" },
    });

    expect(mocks.initBindings).not.toHaveBeenCalled();
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
    expect(mocks.loadUserPermissions).not.toHaveBeenCalled();
  });

  it("keeps setup recovery ahead of admin no-cookie login redirects", async () => {
    const db = createAdminExistsDb([0]);
    mocks.cfEnv.DB = db.db;
    const { adminRouteGuard } = await import("./auth.fns");

    await expect(adminRouteGuard()).rejects.toEqual({
      redirect: { to: "/auth/setup" },
    });

    expect(mocks.initBindings).not.toHaveBeenCalled();
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
    expect(mocks.loadUserPermissions).not.toHaveBeenCalled();
  });

  it("leaves forgot-password reachable without session lookup when no cookie is present", async () => {
    const { redirectIfAuthenticated } = await import("./auth.fns");

    await expect(redirectIfAuthenticated()).resolves.toBeNull();

    expect(mocks.initBindings).not.toHaveBeenCalled();
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
  });
});
