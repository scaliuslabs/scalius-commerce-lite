import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getScannerTokenKey } from "@scalius/shared/scanner-auth";

import { handleCreateScannerToken } from "./scanner-token";

function createRequest() {
  return new Request("http://localhost:4323/api/scanner-token", {
    method: "POST",
  });
}

function createKv() {
  return {
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
  };
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("handleCreateScannerToken", () => {
  it("rejects unauthenticated token creation", async () => {
    const kv = createKv();

    const response = await handleCreateScannerToken(createRequest(), {
      getAuthSession: vi.fn().mockResolvedValue(null),
      getEnv: () => ({ CACHE: kv }),
    });

    expect(response.status).toBe(401);
    expect(await readJson(response)).toMatchObject({
      success: false,
      error: "Authentication required",
    });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects admins without full scanner inventory permissions", async () => {
    const kv = createKv();

    const response = await handleCreateScannerToken(createRequest(), {
      getAuthSession: vi.fn().mockResolvedValue({
        session: { id: "session_1" },
        user: { id: "user_1", email: "admin@example.com", role: "admin" },
      }),
      loadUserPermissions: vi.fn().mockResolvedValue({
        permissions: new Set([PERMISSIONS.SETTINGS_GENERAL_VIEW]),
        isSuperAdmin: false,
      }),
      getEnv: () => ({ CACHE: kv }),
    });

    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({
      success: false,
      error: "Inventory permission required",
    });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("requires product view and edit permissions because scanner sessions can read and mutate stock", async () => {
    const kv = createKv();

    const response = await handleCreateScannerToken(createRequest(), {
      getAuthSession: vi.fn().mockResolvedValue({
        session: { id: "session_1" },
        user: { id: "user_1", name: "Inventory Admin", role: "admin" },
      }),
      loadUserPermissions: vi.fn().mockResolvedValue({
        permissions: new Set([PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT]),
        isSuperAdmin: false,
      }),
      getEnv: () => ({ CACHE: kv }),
      createToken: () => "scanner-token",
      now: () => 123,
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      success: true,
      token: "scanner-token",
    });
    expect(kv.put).toHaveBeenCalledWith(
      await getScannerTokenKey("scanner-token"),
      JSON.stringify({
        adminId: "user_1",
        adminName: "Inventory Admin",
        createdAt: 123,
      }),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });

  it("allows super admins to create scanner tokens", async () => {
    const kv = createKv();

    const response = await handleCreateScannerToken(createRequest(), {
      getAuthSession: vi.fn().mockResolvedValue({
        session: { id: "session_1" },
        user: { id: "owner_1", email: "owner@example.com", role: "admin" },
      }),
      loadUserPermissions: vi.fn().mockResolvedValue({
        permissions: new Set(),
        isSuperAdmin: true,
      }),
      getEnv: () => ({ CACHE: kv }),
      createToken: () => "owner-token",
    });

    expect(response.status).toBe(200);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });
});
