import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: {},
  authHandler: vi.fn(),
  createAuth: vi.fn(),
  selectGet: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

vi.mock("@scalius/core/auth", () => ({
  createAuth: mocks.createAuth,
}));

vi.mock("@scalius/database/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ get: mocks.selectGet }),
      }),
    }),
    update: () => ({
      set: mocks.updateSet.mockImplementation(() => ({
        where: mocks.updateWhere,
      })),
    }),
  }),
}));

describe("admin Better Auth handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authHandler.mockResolvedValue(new Response("ok"));
    mocks.selectGet.mockResolvedValue({ method: "email" });
    mocks.updateWhere.mockResolvedValue({ changes: 1 });
    mocks.createAuth.mockReturnValue({ handler: mocks.authHandler });
  });

  it.each([
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/change-password"],
    ["POST", "/api/auth/reset-password"],
    ["POST", "/api/auth/two-factor/disable"],
    ["POST", "/api/auth/admin/set-user-password"],
    ["GET", "/api/auth/admin/list-users"],
  ])("blocks unused privileged public auth route %s %s", async (method, path) => {
    const { createAuthHandler } = await import("./auth.server");
    const response = await createAuthHandler()(
      new Request(`https://dashboard.scalius.com${path}`, { method }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("exchanges a reset token from the fragment for a short-lived HttpOnly cookie", async () => {
    const { createAuthHandler } = await import("./auth.server");
    const response = await createAuthHandler()(
      new Request("https://dashboard.scalius.com/api/auth/reset-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "one_time_reset_token_1234" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-scalius-password-reset=one_time_reset_token_1234",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("submits password reset proof from the HttpOnly cookie and clears it", async () => {
    mocks.authHandler.mockImplementation(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/api/auth/reset-password");
      await expect(request.json()).resolves.toEqual({
        newPassword: "a strong new password",
        token: "one_time_reset_token_1234",
      });
      return Response.json({ status: true });
    });
    const { createAuthHandler } = await import("./auth.server");
    const response = await createAuthHandler()(
      new Request("https://dashboard.scalius.com/api/auth/reset-password-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "__Host-scalius-password-reset=one_time_reset_token_1234",
        },
        body: JSON.stringify({ newPassword: "a strong new password" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    "/api/auth/two-factor/verify-totp",
    "/api/auth/two-factor/verify-otp",
    "/api/auth/two-factor/verify-backup-code",
  ])("rejects trusted-device direct Better Auth requests for %s", async (path) => {
    const { createAuthHandler } = await import("./auth.server");
    const handler = createAuthHandler();

    const response = await handler(
      new Request(`https://dashboard.scalius.com${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456", trustDevice: true }),
      }),
    );
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe("TRUSTED_DEVICE_DISABLED");
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("allows normal direct Better Auth 2FA verification to reach Better Auth", async () => {
    const { createAuthHandler } = await import("./auth.server");
    const handler = createAuthHandler();

    const response = await handler(
      new Request("https://dashboard.scalius.com/api/auth/two-factor/verify-totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456", trustDevice: false }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.authHandler).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["email", ["totp", "otp"], ["otp", "totp"]],
    ["totp", ["totp", "otp"], ["totp", "otp"]],
    ["email", ["totp"], ["totp"]],
  ])("orders available 2FA methods by the saved %s preference", async (
    savedMethod,
    availableMethods,
    expectedMethods,
  ) => {
    mocks.selectGet.mockResolvedValue({ method: savedMethod });
    mocks.authHandler.mockResolvedValue(Response.json({
      twoFactorRedirect: true,
      twoFactorMethods: availableMethods,
    }));
    const { createAuthHandler } = await import("./auth.server");

    const response = await createAuthHandler()(
      new Request("https://dashboard.scalius.com/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "Admin@Local.Scalius.Test ",
          password: "test-password",
        }),
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      twoFactorMethods: expectedMethods,
    });
  });

  it("marks only a session returned by successful Better Auth 2FA verification", async () => {
    mocks.authHandler.mockResolvedValue(Response.json({
      token: "verified_session_token",
      user: { id: "admin_user" },
    }));
    const { createAuthHandler } = await import("./auth.server");

    const response = await createAuthHandler()(
      new Request("https://dashboard.scalius.com/api/auth/two-factor/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456", trustDevice: false }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      twoFactorVerified: true,
    }));
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
  });
});
