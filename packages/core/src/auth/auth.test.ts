import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailRuntimeContext } from "../integrations/email/provider";

const mocks = vi.hoisted(() => ({
  admin: vi.fn((options: unknown) => ({ id: "admin", options })),
  betterAuth: vi.fn((options: unknown) => ({ options })),
  drizzleAdapter: vi.fn(() => ({ id: "drizzle-adapter" })),
  getDb: vi.fn(() => ({ id: "db" })),
  sendEmail: vi.fn(async (_message: unknown, _context: EmailRuntimeContext | undefined) => ({
    success: false,
    provider: "log" as const,
  })),
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

vi.mock("../integrations/email", () => ({
  sendEmail: mocks.sendEmail,
}));

import { createAuth, getAuth } from "./auth";
import { getEmailProviderReadiness } from "../integrations/email/settings";
import { encryptCredentials } from "../utils/credential-encryption";

function createEmailSettingsDb(rows: Array<{ key: string; value: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => rows,
        }),
      }),
    }),
  };
}

describe("createAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue({ success: false, provider: "log" });
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

  it("does not use JWT_SECRET to decrypt Resend settings for Better Auth email callbacks", async () => {
    const legacyJwtSecret = Buffer.alloc(32, 12).toString("base64");
    const encryptedResendKey = `enc:${await encryptCredentials("re_live_secret", legacyJwtSecret)}`;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getDb.mockReturnValue(createEmailSettingsDb([
      { key: "email_provider", value: "resend" },
      { key: "email_sender", value: "orders@example.com" },
      { key: "resend_api_key", value: encryptedResendKey },
    ]) as never);

    let readiness: Awaited<ReturnType<typeof getEmailProviderReadiness>> | null = null;
    mocks.sendEmail.mockImplementation(async (
      _message: unknown,
      context: Parameters<typeof getEmailProviderReadiness>[0],
    ) => {
      readiness = await getEmailProviderReadiness(context);
      return { success: false, provider: "log" as const };
    });

    try {
      createAuth({
        BETTER_AUTH_SECRET: "test-secret",
        PUBLIC_API_BASE_URL: "http://localhost:8787",
        JWT_SECRET: legacyJwtSecret,
      } as never);

      const options = mocks.betterAuth.mock.calls[0]?.[0] as {
        emailAndPassword?: {
          sendVerificationEmail?: (input: {
            user: { email: string; name: string };
            url: string;
          }) => Promise<void>;
        };
      };
      const sendVerificationEmail = options.emailAndPassword?.sendVerificationEmail;
      if (!sendVerificationEmail) {
        throw new Error("Expected sendVerificationEmail callback");
      }

      await sendVerificationEmail({
        user: { email: "admin@example.com", name: "Admin" },
        url: "https://api.example.com/verify",
      });

      const emailContext = mocks.sendEmail.mock.calls[0]?.[1] as
        | { encryptionKey?: string; env?: Record<string, unknown> }
        | undefined;
      expect(emailContext?.env?.JWT_SECRET).toBe(legacyJwtSecret);
      expect(emailContext?.encryptionKey).toBeUndefined();
      expect(readiness).toMatchObject({
        configured: false,
        provider: "resend",
        sender: "orders@example.com",
        senderConfigured: true,
        cloudflareBindingConfigured: false,
        resendConfigured: false,
        error: "Resend API key is encrypted but CREDENTIAL_ENCRYPTION_KEY is not configured.",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("clears invited-admin password setup after a reset token is consumed", async () => {
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    mocks.getDb.mockReturnValueOnce({
      id: "db",
      update,
    } as never);

    createAuth({
      BETTER_AUTH_SECRET: "test-secret",
      PUBLIC_API_BASE_URL: "http://localhost:8787",
    } as never);

    const options = mocks.betterAuth.mock.calls[0]?.[0] as {
      emailAndPassword?: {
        onPasswordReset?: (input: { user: { id: string } }) => Promise<void>;
      };
    };

    await options.emailAndPassword?.onPasswordReset?.({ user: { id: "user_1" } });

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      mustChangePassword: false,
      updatedAt: expect.any(Date),
    }));
    expect(where).toHaveBeenCalledTimes(1);
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
