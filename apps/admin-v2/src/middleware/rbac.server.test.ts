import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: { CACHE: {} },
  db: { marker: "db" },
  getDb: vi.fn(),
  autoSeedRbacIfNeeded: vi.fn(),
  getUserPermissions: vi.fn(),
  isSuperAdmin: vi.fn(),
  retryTransientD1: vi.fn((operation: () => unknown) => operation()),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/auth/rbac/auto-seed", () => ({
  autoSeedRbacIfNeeded: mocks.autoSeedRbacIfNeeded,
}));

vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  getUserPermissions: mocks.getUserPermissions,
  isSuperAdmin: mocks.isSuperAdmin,
}));

vi.mock("@scalius/core/utils/transient-d1", () => ({
  retryTransientD1: mocks.retryTransientD1,
}));

describe("loadUserPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue(mocks.db);
    mocks.autoSeedRbacIfNeeded.mockResolvedValue(undefined);
    mocks.getUserPermissions.mockResolvedValue(new Set(["orders.read"]));
    mocks.isSuperAdmin.mockResolvedValue(false);
    mocks.retryTransientD1.mockImplementation((operation: () => unknown) => operation());
  });

  it("uses a fresh Better Auth super-admin value without loading D1 or seeding", async () => {
    const { loadUserPermissions } = await import("./rbac.server");

    const context = await loadUserPermissions("user_1", "admin", true);

    expect(context.isSuperAdmin).toBe(true);
    expect(context.hasAdminAccess).toBe(true);
    expect(context.permissions).toEqual(new Set());
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.autoSeedRbacIfNeeded).not.toHaveBeenCalled();
    expect(mocks.retryTransientD1).not.toHaveBeenCalled();
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(mocks.isSuperAdmin).not.toHaveBeenCalled();
  });

  it("uses a known non-super-admin value while loading effective grants", async () => {
    const { loadUserPermissions } = await import("./rbac.server");

    const context = await loadUserPermissions("user_1", "admin", false);

    expect(context.isSuperAdmin).toBe(false);
    expect(context.hasAdminAccess).toBe(true);
    expect(context.permissions).toEqual(new Set(["orders.read"]));
    expect(mocks.autoSeedRbacIfNeeded).toHaveBeenCalledWith(
      mocks.db,
      mocks.cfEnv.CACHE,
    );
    expect(mocks.getUserPermissions).toHaveBeenCalledWith(
      mocks.db,
      "user_1",
      mocks.cfEnv.CACHE,
    );
    expect(mocks.isSuperAdmin).not.toHaveBeenCalled();
  });

  it("falls back to the authoritative super-admin query when auth omits it", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set());
    mocks.isSuperAdmin.mockResolvedValue(true);
    const { loadUserPermissions } = await import("./rbac.server");

    const context = await loadUserPermissions("user_2", null, null);

    expect(context.isSuperAdmin).toBe(true);
    expect(context.hasAdminAccess).toBe(true);
    expect(mocks.isSuperAdmin).toHaveBeenCalledWith(mocks.db, "user_2");
  });
});
