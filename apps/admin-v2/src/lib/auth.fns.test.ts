import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: {} as { BETTER_AUTH_SECRET?: string; DB?: unknown },
  retryTransientD1: vi.fn((operation: () => unknown) => operation()),
  getRequestHeader: vi.fn(),
  loadUserPermissions: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

vi.mock("@scalius/core/utils/transient-d1", () => ({
  retryTransientD1: mocks.retryTransientD1,
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
  const first = vi.fn(async () =>
    (counts.shift() ?? 0) > 0 ? { found: 1 } : null,
  );
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    db: { prepare },
    first,
    bind,
    prepare,
  };
}

function createDeferredAdminExistsDb() {
  let resolveFirst: (value: { found: number }) => void = () => {};
  const first = vi.fn(
    () =>
      new Promise<{ found: number }>((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    db: { prepare },
    first,
    bind,
    prepare,
    resolveFirst: (value: { found: number }) => resolveFirst(value),
  };
}

function createAdminGuardDb(sessionRow: Record<string, unknown> | null) {
  const adminFirst = vi.fn(async () => ({ found: 1 }));
  const sessionFirst = vi.fn(async () => sessionRow);
  const adminBind = vi.fn(() => ({ first: adminFirst }));
  const sessionBind = vi.fn(() => ({ first: sessionFirst }));
  const prepare = vi.fn((sql: string) => {
    if (sql.includes("FROM session s")) {
      return { bind: sessionBind };
    }
    return { bind: adminBind };
  });

  return {
    db: { prepare },
    adminFirst,
    sessionFirst,
    adminBind,
    sessionBind,
    prepare,
  };
}

const TEST_SECRET = "test-better-auth-secret";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function signCookieValue(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return `${token}.${encodeBase64(new Uint8Array(signature))}`;
}

describe("admin setup guard cache", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.cfEnv.BETTER_AUTH_SECRET = TEST_SECRET;
    mocks.retryTransientD1.mockImplementation((operation: () => unknown) => operation());
    mocks.getRequestHeader.mockReturnValue("");
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

    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.prepare).toHaveBeenCalledWith(
      "SELECT 1 as found FROM user WHERE role = ? OR is_super_admin = 1 LIMIT 1",
    );
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

  it("deduplicates concurrent cold admin-exists reads inside one isolate", async () => {
    const warmupDb = createAdminExistsDb([0]);
    mocks.cfEnv.DB = warmupDb.db;
    const { checkAdminExists, clearAdminExistsCache } = await import("./auth.fns");

    await expect(checkAdminExists()).resolves.toBe(false);
    clearAdminExistsCache();

    const db = createDeferredAdminExistsDb();
    mocks.cfEnv.DB = db.db;

    const firstCheck = checkAdminExists();
    const secondCheck = checkAdminExists();

    await vi.waitFor(() => {
      expect(db.prepare).toHaveBeenCalledTimes(1);
      expect(db.first).toHaveBeenCalledTimes(1);
    });

    db.resolveFirst({ found: 1 });

    await expect(Promise.all([firstCheck, secondCheck])).resolves.toEqual([
      true,
      true,
    ]);
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
    const db = createAdminGuardDb({
      sessionId: "session_1",
      userId: "user_1",
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
      image: null,
      twoFactorEnabled: 0,
      twoFactorVerified: 1,
      isSuperAdmin: 1,
    });
    mocks.cfEnv.DB = db.db;
    mocks.getRequestHeader.mockReturnValue(`better-auth.session_token=${await signCookieValue("token")}`);
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
    expect(db.sessionBind).toHaveBeenCalledWith("token");
  });

  it("returns no session without querying session state when no cookie is present", async () => {
    const { getSessionInfo } = await import("./auth.fns");

    await expect(getSessionInfo()).resolves.toBeNull();

    expect(mocks.retryTransientD1).not.toHaveBeenCalled();
  });

  it("lets the login page render without session lookup when no cookie is present", async () => {
    const db = createAdminExistsDb([1]);
    mocks.cfEnv.DB = db.db;
    const { loginPageGuard } = await import("./auth.fns");

    await expect(loginPageGuard()).resolves.toBeNull();

    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps setup recovery ahead of login no-cookie fast path", async () => {
    const db = createAdminExistsDb([0]);
    mocks.cfEnv.DB = db.db;
    const { loginPageGuard } = await import("./auth.fns");

    await expect(loginPageGuard()).rejects.toEqual({
      redirect: { to: "/auth/setup" },
    });

    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it("redirects anonymous admin requests without session or RBAC reads", async () => {
    const db = createAdminExistsDb([1]);
    mocks.cfEnv.DB = db.db;
    const { adminRouteGuard } = await import("./auth.fns");

    await expect(adminRouteGuard()).rejects.toEqual({
      redirect: { to: "/auth/login" },
    });

    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.loadUserPermissions).not.toHaveBeenCalled();
  });

  it("keeps setup recovery ahead of admin no-cookie login redirects", async () => {
    const db = createAdminExistsDb([0]);
    mocks.cfEnv.DB = db.db;
    const { adminRouteGuard } = await import("./auth.fns");

    await expect(adminRouteGuard()).rejects.toEqual({
      redirect: { to: "/auth/setup" },
    });

    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.loadUserPermissions).not.toHaveBeenCalled();
  });

  it("leaves forgot-password reachable without session lookup when no cookie is present", async () => {
    const { redirectIfAuthenticated } = await import("./auth.fns");

    await expect(redirectIfAuthenticated()).resolves.toBeNull();

    expect(mocks.retryTransientD1).not.toHaveBeenCalled();
  });
});
