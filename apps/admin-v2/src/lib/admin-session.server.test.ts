import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  getAdminSessionFromCookieHeader,
  getAdminSessionTokenFromCookieHeader,
  verifyBetterAuthSignedCookieValue,
} from "./admin-session.server";

const mocks = vi.hoisted(() => ({
  retryTransientD1: vi.fn((operation: () => unknown) => operation()),
}));

vi.mock("@scalius/core/utils/transient-d1", () => ({
  retryTransientD1: mocks.retryTransientD1,
}));

function createSessionDb(row: Record<string, unknown> | null) {
  const get = vi.fn(async (_query: SQL) => row);

  return {
    db: { get },
    get,
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

async function signCookieValue(token: string, secret = TEST_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
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

describe("admin session direct D1 lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retryTransientD1.mockImplementation((operation: () => unknown) => operation());
  });

  it("extracts signed Better Auth tokens from normal and secure cookies", async () => {
    const normalCookie = await signCookieValue("session_token");
    const secureCookie = await signCookieValue("secure_token");

    await expect(
      getAdminSessionTokenFromCookieHeader(
        `theme=dark; better-auth.session_token=${normalCookie}; other=1`,
        TEST_SECRET,
      ),
    ).resolves.toBe("session_token");

    await expect(
      getAdminSessionTokenFromCookieHeader(
        `__Secure-better-auth.session_token=${encodeURIComponent(secureCookie)}`,
        TEST_SECRET,
      ),
    ).resolves.toBe("secure_token");
  });

  it("rejects unsigned, tampered, and wrong-secret Better Auth cookies", async () => {
    const signedCookie = await signCookieValue("session_token");

    await expect(verifyBetterAuthSignedCookieValue("session_token", TEST_SECRET)).resolves.toBeNull();
    await expect(verifyBetterAuthSignedCookieValue(`${signedCookie}tampered`, TEST_SECRET)).resolves.toBeNull();
    await expect(verifyBetterAuthSignedCookieValue(signedCookie, "wrong-secret")).resolves.toBeNull();
    await expect(verifyBetterAuthSignedCookieValue(signedCookie, "")).resolves.toBeNull();
  });

  it("returns null without touching D1 when no session cookie is present", async () => {
    const db = createSessionDb(null);

    await expect(
      getAdminSessionFromCookieHeader(
        db.db,
        "theme=dark",
        TEST_SECRET,
      ),
    ).resolves.toBeNull();

    expect(db.get).not.toHaveBeenCalled();
    expect(mocks.retryTransientD1).not.toHaveBeenCalled();
  });

  it("returns null without touching D1 when the cookie is unsigned or tampered", async () => {
    const db = createSessionDb(null);
    const signedCookie = await signCookieValue("session_token");

    await expect(
      getAdminSessionFromCookieHeader(
        db.db,
        "better-auth.session_token=session_token",
        TEST_SECRET,
      ),
    ).resolves.toBeNull();

    await expect(
      getAdminSessionFromCookieHeader(
        db.db,
        `better-auth.session_token=${signedCookie}tampered`,
        TEST_SECRET,
      ),
    ).resolves.toBeNull();

    expect(db.get).not.toHaveBeenCalled();
    expect(mocks.retryTransientD1).not.toHaveBeenCalled();
  });

  it("queries the active session and maps user/session booleans", async () => {
    const db = createSessionDb({
      sessionId: "session_1",
      userId: "user_1",
      name: "Admin",
      email: "admin@example.com",
      image: null,
      role: "admin",
      twoFactorEnabled: 1,
      mustChangePassword: 1,
      mustEnrollTwoFactor: 0,
      twoFactorVerified: 1,
      isSuperAdmin: 1,
    });
    const signedCookie = await signCookieValue("session_token");

    await expect(
      getAdminSessionFromCookieHeader(
        db.db,
        `better-auth.session_token=${signedCookie}`,
        TEST_SECRET,
      ),
    ).resolves.toEqual({
      user: {
        id: "user_1",
        name: "Admin",
        email: "admin@example.com",
        image: null,
        role: "admin",
        twoFactorEnabled: true,
        mustChangePassword: true,
        mustEnrollTwoFactor: false,
        isSuperAdmin: true,
      },
      session: {
        id: "session_1",
        twoFactorVerified: true,
      },
    });

    const query = new SQLiteSyncDialect().sqlToQuery(
      db.get.mock.calls[0]?.[0] as SQL,
    );
    expect(query.params).toEqual(["session_token"]);
    expect(query.sql).toContain("s.expires_at > unixepoch()");
    expect(query.sql).toContain("u.banned = 0");
    expect(query.sql).toContain("u.must_change_password");
    expect(query.sql).toContain("u.must_enroll_two_factor");
  });
});
