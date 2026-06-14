import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn((options: unknown) => ({ id: "admin", options })),
  betterAuth: vi.fn((options: unknown) => ({ options })),
  drizzleAdapter: vi.fn(() => ({ id: "drizzle-adapter" })),
  getDb: vi.fn(() => ({ id: "db" })),
  twoFactor: vi.fn((options: unknown) => ({ id: "two-factor", options })),
}));

vi.mock("better-auth", () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}));

vi.mock("better-auth/plugins", () => ({
  admin: mocks.admin,
  twoFactor: mocks.twoFactor,
}));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

import { createAuth, getAuth } from "./auth";

describe("createAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the two-factor session flag to the Drizzle schema field", () => {
    createAuth({
      BETTER_AUTH_SECRET: "test-secret",
      PUBLIC_API_BASE_URL: "http://localhost:8787",
    } as never);

    const options = mocks.betterAuth.mock.calls[0]?.[0] as {
      session?: {
        additionalFields?: {
          twoFactorVerified?: {
            fieldName?: string;
          };
        };
      };
    };

    expect(options.session?.additionalFields?.twoFactorVerified?.fieldName).toBe(
      "twoFactorVerified",
    );
  });

  it("passes the Better Auth 1.6 two-factor verified column to the Drizzle adapter", () => {
    createAuth({
      BETTER_AUTH_SECRET: "test-secret",
      PUBLIC_API_BASE_URL: "http://localhost:8787",
    } as never);

    const adapterCalls = mocks.drizzleAdapter.mock.calls as unknown as Array<
      [
        unknown,
        {
          schema?: {
            twoFactor?: Record<string, unknown>;
          };
        },
      ]
    >;
    const adapterOptions = adapterCalls[0]?.[1];

    if (!adapterOptions) {
      throw new Error("Expected Drizzle adapter options");
    }
    expect(adapterOptions.schema?.twoFactor).toHaveProperty("verified");
  });

  it("revokes existing sessions after password reset", () => {
    createAuth({
      BETTER_AUTH_SECRET: "test-secret",
      PUBLIC_API_BASE_URL: "http://localhost:8787",
    } as never);

    const options = mocks.betterAuth.mock.calls[0]?.[0] as {
      emailAndPassword?: {
        revokeSessionsOnPasswordReset?: boolean;
      };
    };

    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("does not reuse the cached auth instance when auth URLs or trusted origins change", () => {
    const first = getAuth({
      BETTER_AUTH_SECRET: "test-secret",
      BETTER_AUTH_URL: "https://api-one.example.com",
      PUBLIC_API_BASE_URL: "https://api-one.example.com",
      STOREFRONT_URL: "https://store-one.example.com",
    } as never);

    const cached = getAuth({
      BETTER_AUTH_SECRET: "test-secret",
      BETTER_AUTH_URL: "https://api-one.example.com",
      PUBLIC_API_BASE_URL: "https://api-one.example.com",
      STOREFRONT_URL: "https://store-one.example.com",
    } as never);

    const nextOrigin = getAuth({
      BETTER_AUTH_SECRET: "test-secret",
      BETTER_AUTH_URL: "https://api-two.example.com",
      PUBLIC_API_BASE_URL: "https://api-two.example.com",
      STOREFRONT_URL: "https://store-two.example.com",
    } as never);

    expect(cached).toBe(first);
    expect(nextOrigin).not.toBe(first);
    expect(mocks.betterAuth).toHaveBeenCalledTimes(2);
    expect((nextOrigin as { options: { baseURL?: string } }).options.baseURL).toBe(
      "https://api-two.example.com",
    );
  });
});
