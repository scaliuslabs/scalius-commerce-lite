import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAdminSessionFromCookieHeader,
  getAdminSessionTokenFromCookieHeader,
} from "./admin-session.server";

const mocks = vi.hoisted(() => ({
  retryTransientD1: vi.fn((operation: () => unknown) => operation()),
}));

vi.mock("@scalius/core/utils/transient-d1", () => ({
  retryTransientD1: mocks.retryTransientD1,
}));

function createSessionDb(row: Record<string, unknown> | null) {
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn((_sql: string) => ({ bind }));

  return {
    db: { prepare },
    first,
    bind,
    prepare,
  };
}

describe("admin session direct D1 lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retryTransientD1.mockImplementation((operation: () => unknown) => operation());
  });

  it("extracts the unsigned Better Auth token from normal and secure cookies", () => {
    expect(
      getAdminSessionTokenFromCookieHeader(
        "theme=dark; better-auth.session_token=session_token.signature; other=1",
      ),
    ).toBe("session_token");

    expect(
      getAdminSessionTokenFromCookieHeader(
        "__Secure-better-auth.session_token=secure_token%2Esignature",
      ),
    ).toBe("secure_token");
  });

  it("returns null without touching D1 when no session cookie is present", async () => {
    const db = createSessionDb(null);

    await expect(
      getAdminSessionFromCookieHeader(db.db as unknown as Pick<D1Database, "prepare">, "theme=dark"),
    ).resolves.toBeNull();

    expect(db.prepare).not.toHaveBeenCalled();
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
      twoFactorVerified: 1,
      isSuperAdmin: 1,
    });

    await expect(
      getAdminSessionFromCookieHeader(
        db.db as unknown as Pick<D1Database, "prepare">,
        "better-auth.session_token=session_token.signature",
      ),
    ).resolves.toEqual({
      user: {
        id: "user_1",
        name: "Admin",
        email: "admin@example.com",
        image: null,
        role: "admin",
        twoFactorEnabled: true,
        isSuperAdmin: true,
      },
      session: {
        id: "session_1",
        twoFactorVerified: true,
      },
    });

    expect(db.bind).toHaveBeenCalledWith("session_token");
    const sql = String(db.prepare.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("s.expires_at > unixepoch()");
    expect(sql).toContain("u.banned = 0");
  });
});
