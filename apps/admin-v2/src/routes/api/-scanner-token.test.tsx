import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { UnauthorizedError } from "@scalius/core/errors";
import {
  SCANNER_SESSION_TTL_SECONDS,
  getScannerSessionKey,
} from "@scalius/shared/scanner-auth";

import { handleCreateScannerToken, handleExchangeScannerToken } from "./scanner-token";

function createRequest() {
  return new Request("http://localhost:4323/api/scanner-token", {
    method: "POST",
  });
}

function createCrossOriginCookieRequest() {
  return new Request("https://dashboard.example.test/api/scanner-token", {
    method: "POST",
    headers: {
      Cookie: "better-auth.session_token=session.signature",
      Origin: "https://evil.example.test",
    },
  });
}

function createKv() {
  return {
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
  };
}

function createDb() {
  return { id: "db" };
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("handleCreateScannerToken", () => {
  it("rejects cross-origin cookie requests before auth or KV work", async () => {
    const kv = createKv();
    const getAuthSession = vi.fn();

    const response = await handleCreateScannerToken(createCrossOriginCookieRequest(), {
      getAuthSession,
      getEnv: () => ({ CACHE: kv }),
    });

    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({
      success: false,
      error: "Cross-origin cookie request denied",
    });
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

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

  it("rejects pending 2FA sessions before loading permissions or minting tokens", async () => {
    const kv = createKv();
    const loadUserPermissions = vi.fn();

    const response = await handleCreateScannerToken(createRequest(), {
      getAuthSession: vi.fn().mockResolvedValue({
        session: { id: "session_1", twoFactorVerified: false },
        user: {
          id: "user_1",
          email: "admin@example.com",
          role: "admin",
          twoFactorEnabled: true,
        },
      }),
      loadUserPermissions,
      getEnv: () => ({ CACHE: kv }),
    });

    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({
      success: false,
      error: "Two-factor verification required",
    });
    expect(loadUserPermissions).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("requires product view and edit permissions because scanner sessions can read and mutate stock", async () => {
    const kv = createKv();
    const db = createDb();
    const createTokenClaim = vi.fn().mockResolvedValue(undefined);

    const response = await handleCreateScannerToken(createRequest(), {
      getAuthSession: vi.fn().mockResolvedValue({
        session: { id: "session_1", twoFactorVerified: true },
        user: {
          id: "user_1",
          name: "Inventory Admin",
          role: "admin",
          twoFactorEnabled: true,
        },
      }),
      loadUserPermissions: vi.fn().mockResolvedValue({
        permissions: new Set([
          PERMISSIONS.PRODUCTS_VIEW,
          PERMISSIONS.PRODUCTS_EDIT,
        ]),
        isSuperAdmin: false,
      }),
      getEnv: () => ({ CACHE: kv, DB: {} as D1Database }),
      getDb: () => db as never,
      createTokenClaim,
      createToken: () => "scanner-token",
      now: () => 123,
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      success: true,
      token: "scanner-token",
    });
    expect(createTokenClaim).toHaveBeenCalledWith(
      db,
      {
        token: "scanner-token",
        adminId: "user_1",
        adminName: "Inventory Admin",
        nowMs: 123,
      },
    );
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("allows super admins to create scanner tokens", async () => {
    const kv = createKv();
    const createTokenClaim = vi.fn().mockResolvedValue(undefined);

    const response = await handleCreateScannerToken(createRequest(), {
      getAuthSession: vi.fn().mockResolvedValue({
        session: { id: "session_1" },
        user: { id: "owner_1", email: "owner@example.com", role: "admin" },
      }),
      loadUserPermissions: vi.fn().mockResolvedValue({
        permissions: new Set(),
        isSuperAdmin: true,
      }),
      getEnv: () => ({ CACHE: kv, DB: {} as D1Database }),
      getDb: () => createDb() as never,
      createTokenClaim,
      createToken: () => "owner-token",
    });

    expect(response.status).toBe(200);
    expect(createTokenClaim).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("handleExchangeScannerToken", () => {
  it("claims a QR token through D1 before writing a scanner session", async () => {
    const kv = createKv();
    const db = createDb();
    const consumeTokenClaim = vi.fn().mockResolvedValue({
      tokenHash: "token_hash_1",
      adminId: "admin_1",
      adminName: "Inventory Admin",
    });

    const response = await handleExchangeScannerToken(
      new Request("https://dashboard.example.test/api/scanner-token?token=scanner-token"),
      {
        getEnv: () => ({ CACHE: kv, DB: {} as D1Database }),
        getDb: () => db as never,
        createSessionId: () => "scanner-session-1",
        consumeTokenClaim,
        now: () => 1_234,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("scanner_sid=scanner-session-1");
    expect(consumeTokenClaim).toHaveBeenCalledWith(db, {
      token: "scanner-token",
      sessionId: "scanner-session-1",
      nowMs: 1_234,
    });
    expect(kv.put).toHaveBeenCalledWith(
      await getScannerSessionKey("scanner-session-1"),
      JSON.stringify({
        adminId: "admin_1",
        adminName: "Inventory Admin",
        createdAt: 1_234,
        lastSeenAt: 1_234,
        claimTokenHash: "token_hash_1",
      }),
      { expirationTtl: SCANNER_SESSION_TTL_SECONDS },
    );
  });

  it("lets only one racing QR-token exchange mint a scanner session", async () => {
    const kv = createKv();
    const db = createDb();
    let claimed = false;
    const consumeTokenClaim = vi.fn(async () => {
      if (claimed) {
        throw new UnauthorizedError("Token invalid or expired");
      }
      claimed = true;
      return {
        tokenHash: "token_hash_1",
        adminId: "admin_1",
        adminName: "Inventory Admin",
      };
    });
    let sessionCounter = 0;

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        handleExchangeScannerToken(
          new Request("https://dashboard.example.test/api/scanner-token?token=scanner-token"),
          {
            getEnv: () => ({ CACHE: kv, DB: {} as D1Database }),
            getDb: () => db as never,
            createSessionId: () => `scanner-session-${++sessionCounter}`,
            consumeTokenClaim,
            now: () => 2_000,
          },
        ),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(3);
    expect(responses.filter((response) => response.headers.has("Set-Cookie"))).toHaveLength(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it("refreshes an existing scanner session when no token is supplied", async () => {
    const kv = createKv();
    kv.get.mockResolvedValue(JSON.stringify({
      adminId: "admin_1",
      adminName: "Inventory Admin",
      createdAt: 1_000,
      lastSeenAt: 1_000,
      claimTokenHash: "token_hash_1",
    }));

    const response = await handleExchangeScannerToken(
      new Request("https://dashboard.example.test/api/scanner-token", {
        headers: { Cookie: "scanner_sid=scanner-session-1" },
      }),
      {
        getEnv: () => ({ CACHE: kv }),
        now: () => 3_000,
      },
    );

    expect(response.status).toBe(200);
    expect(kv.put).toHaveBeenCalledWith(
      await getScannerSessionKey("scanner-session-1"),
      JSON.stringify({
        adminId: "admin_1",
        adminName: "Inventory Admin",
        createdAt: 1_000,
        lastSeenAt: 3_000,
        claimTokenHash: "token_hash_1",
      }),
      { expirationTtl: SCANNER_SESSION_TTL_SECONDS },
    );
  });
});
