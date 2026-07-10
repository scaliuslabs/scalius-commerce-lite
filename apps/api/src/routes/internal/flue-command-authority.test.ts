import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  hash: vi.fn(),
  equal: vi.fn((left: string, right: string) => left === right),
  seed: vi.fn(),
  freshPermissions: vi.fn(),
  storefrontDeployment: vi.fn(),
  assertStorefront: vi.fn(),
}));

vi.mock("@scalius/core/modules/assistant", () => ({
  resolveAssistantSessionByAgentInstance: mocks.resolveSession,
  hashAssistantArguments: mocks.hash,
  constantTimeAssistantHashEqual: mocks.equal,
}));
vi.mock("@scalius/core/auth/rbac/auto-seed", () => ({
  autoSeedRbacIfNeeded: mocks.seed,
}));
vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  getFreshUserPermissionsFromD1: mocks.freshPermissions,
}));
vi.mock("@scalius/core/utils/transient-d1", () => ({
  retryTransientD1: (operation: () => unknown) => operation(),
}));
vi.mock("./storefront-assistant-context", () => ({
  resolveStorefrontAssistantDeploymentContext: mocks.storefrontDeployment,
  assertCurrentStorefrontAssistantSession: mocks.assertStorefront,
}));

import {
  resolveAdminFlueCommandAuthority,
  resolveStorefrontFlueCommandAuthority,
} from "./flue-command-authority";

const INSTANCE_ID = `v1.${"i".repeat(43)}`;

function queryBuilder() {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder),
  };
  return builder;
}

function testContext(overrides: {
  userRows?: unknown[];
  dashboardRows?: unknown[];
} = {}) {
  const cache = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
  const db = {
    select: vi.fn(() => queryBuilder()),
    batch: vi.fn(async () => [
      overrides.userRows ?? [{
        id: "admin_1",
        isSuperAdmin: false,
        banned: false,
        banExpires: null,
        twoFactorEnabled: true,
        mustChangePassword: false,
        mustEnrollTwoFactor: false,
      }],
      overrides.dashboardRows ?? [{
        id: "dashboard_session_1",
        twoFactorVerified: true,
      }],
    ]),
  };
  return {
    context: {
      get: (key: string) => key === "db" ? db : undefined,
      env: { CACHE: cache },
    } as never,
    db,
    cache,
  };
}

describe("Flue command instance authority", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveSession.mockResolvedValue({
      id: "as_1",
      surface: "admin",
      actorType: "admin",
      actorId: "admin_1",
      status: "active",
      permissionSnapshotHash: "permission_hash",
      safeMetadata: {
        schemaVersion: 1,
        dashboardSessionHash: "d".repeat(64),
      },
    });
    mocks.hash.mockImplementation(async (value: { version?: string }) =>
      value.version === "admin-assistant-dashboard-session:v1"
        ? "d".repeat(64)
        : "permission_hash");
    mocks.freshPermissions.mockResolvedValue(new Set(["products.view"]));
    mocks.storefrontDeployment.mockResolvedValue({ deploymentBindingHash: "x".repeat(64) });
  });

  it("revalidates the active dashboard session, 2FA, and current permission snapshot", async () => {
    const { context, db, cache } = testContext();
    await expect(resolveAdminFlueCommandAuthority(context, INSTANCE_ID)).resolves.toEqual({
      session: expect.objectContaining({ id: "as_1", actorId: "admin_1" }),
      permissions: new Set(["products.view"]),
    });
    expect(mocks.resolveSession).toHaveBeenCalledWith(db, {
      agentInstanceId: INSTANCE_ID,
      expectedSurface: "admin",
    });
    expect(mocks.seed).toHaveBeenCalledOnce();
    expect(mocks.freshPermissions).toHaveBeenCalledWith(db, "admin_1");
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(mocks.hash).toHaveBeenCalledWith(expect.objectContaining({
      version: "admin-assistant-permission-snapshot:v1",
      actorId: "admin_1",
      permissions: ["products.view"],
    }));
  });

  it("invalidates the thread after fresh D1 revokes a stale cached role grant", async () => {
    const { context, db, cache } = testContext();
    cache.get.mockResolvedValue(["products.view"]);
    mocks.freshPermissions.mockResolvedValue(new Set(["dashboard.view"]));
    mocks.hash.mockImplementation(async (value: {
      version?: string;
      permissions?: string[];
    }) => value.version === "admin-assistant-dashboard-session:v1"
      ? "d".repeat(64)
      : value.permissions?.includes("products.view")
        ? "permission_hash"
        : "changed_permission_hash");

    await expect(resolveAdminFlueCommandAuthority(context, INSTANCE_ID))
      .rejects.toThrow("Admin permissions changed");

    expect(mocks.freshPermissions).toHaveBeenCalledWith(db, "admin_1");
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("retains the fresh super-admin registry in the permission snapshot hash", async () => {
    const permissions = new Set(["taxes.view", "taxes.manage", "products.view"]);
    mocks.freshPermissions.mockResolvedValue(permissions);
    const { context } = testContext();

    await expect(resolveAdminFlueCommandAuthority(context, INSTANCE_ID))
      .resolves.toEqual({
        session: expect.objectContaining({ id: "as_1" }),
        permissions,
      });
    expect(mocks.hash).toHaveBeenCalledWith(expect.objectContaining({
      version: "admin-assistant-permission-snapshot:v1",
      permissions: ["products.view", "taxes.manage", "taxes.view"],
    }));
  });

  it("fails closed after dashboard-session, 2FA, or permission drift", async () => {
    const missingDashboard = testContext({ dashboardRows: [] });
    await expect(resolveAdminFlueCommandAuthority(
      missingDashboard.context,
      INSTANCE_ID,
    )).rejects.toThrow("Assistant session is unavailable.");

    const unverified = testContext({
      dashboardRows: [{ id: "dashboard_session_1", twoFactorVerified: false }],
    });
    await expect(resolveAdminFlueCommandAuthority(unverified.context, INSTANCE_ID))
      .rejects.toThrow("Two-factor verification is required.");

    const permissionDrift = testContext();
    mocks.hash.mockImplementation(async (value: { version?: string }) =>
      value.version === "admin-assistant-dashboard-session:v1"
        ? "d".repeat(64)
        : "changed_permission_hash");
    await expect(resolveAdminFlueCommandAuthority(permissionDrift.context, INSTANCE_ID))
      .rejects.toThrow("Admin permissions changed");
  });

  it("revalidates Storefront deployment metadata after instance resolution", async () => {
    const storefrontSession = {
      id: "as_storefront",
      surface: "storefront",
      actorType: "guest",
      actorId: "guest_1",
    };
    mocks.resolveSession.mockResolvedValue(storefrontSession);
    const { context, db } = testContext();
    await expect(resolveStorefrontFlueCommandAuthority(context, INSTANCE_ID))
      .resolves.toBe(storefrontSession);
    expect(mocks.resolveSession).toHaveBeenCalledWith(db, {
      agentInstanceId: INSTANCE_ID,
      expectedSurface: "storefront",
    });
    expect(mocks.assertStorefront).toHaveBeenCalledWith(
      storefrontSession,
      { deploymentBindingHash: "x".repeat(64) },
    );
  });
});
