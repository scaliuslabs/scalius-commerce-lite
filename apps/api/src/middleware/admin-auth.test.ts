import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

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

function createContext(pathname: string, method = "GET") {
  const request = new Request(`https://api.scalius.test${pathname}`, { method });

  return {
    env: {},
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
    mocks.getAuth.mockReturnValue({
      api: {
        getSession: vi.fn().mockResolvedValue({
          user: { id: "admin_1", email: "admin@example.com", name: "Admin", role: "admin" },
        }),
      },
    });
  });

  it("allows a mapped admin route when the user has the required permission", async () => {
    mocks.getUserPermissions.mockResolvedValue(new Set([PERMISSIONS.PRODUCTS_VIEW]));
    const next = vi.fn().mockResolvedValue(undefined);

    await adminAuthMiddleware(createContext("/api/v1/admin/products") as never, next);

    expect(next).toHaveBeenCalledTimes(1);
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
});
