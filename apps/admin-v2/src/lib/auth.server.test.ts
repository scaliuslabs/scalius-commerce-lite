import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: {},
  authHandler: vi.fn(),
  createAuth: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

vi.mock("@scalius/core/auth", () => ({
  createAuth: mocks.createAuth,
}));

describe("admin Better Auth handler trusted-device policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authHandler.mockResolvedValue(new Response("ok"));
    mocks.createAuth.mockReturnValue({ handler: mocks.authHandler });
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
    expect(mocks.authHandler).toHaveBeenCalledTimes(1);
  });
});
