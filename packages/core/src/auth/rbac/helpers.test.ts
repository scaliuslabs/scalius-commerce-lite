import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "./permissions";
import {
  clearAllPermissionCache,
  getUserPermissions,
} from "./helpers";

function createSelectChain() {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  };
  return chain;
}

describe("RBAC permission cache", () => {
  beforeEach(() => {
    clearAllPermissionCache();
  });

  it("does not trust stale local memory after a KV permission cache miss", async () => {
    const selectChain = createSelectChain();
    const db = {
      select: vi.fn(() => selectChain),
      batch: vi.fn().mockResolvedValue([
        [{ id: "user_1", isSuperAdmin: false }],
        [{ permissionName: PERMISSIONS.ORDERS_VIEW }],
        [],
      ]),
    };
    const kv = {
      get: vi
        .fn()
        .mockResolvedValueOnce([PERMISSIONS.PRODUCTS_VIEW])
        .mockResolvedValueOnce(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const cached = await getUserPermissions(db as never, "user_1", kv as never);
    expect(cached).toEqual(new Set([PERMISSIONS.PRODUCTS_VIEW]));
    expect(db.batch).not.toHaveBeenCalled();

    const refreshed = await getUserPermissions(db as never, "user_1", kv as never);
    expect(refreshed).toEqual(new Set([PERMISSIONS.ORDERS_VIEW]));
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(
      "rbac:perms:user_1",
      JSON.stringify([PERMISSIONS.ORDERS_VIEW]),
      { expirationTtl: 300 },
    );
  });
});
