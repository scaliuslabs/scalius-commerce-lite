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

import { createAuth } from "./auth";

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
});
