import { describe, expect, it } from "vitest";
import {
  getCredentialEncryptionKey,
  getCustomerSessionHashKey,
  getEncryptionKey,
  requireEncryptionKey,
} from "./encryption-key";
import { ServiceUnavailableError } from "./api-error";

describe("encryption key helpers", () => {
  it("prefers the dedicated credential encryption key over JWT legacy fallback", () => {
    expect(
      getEncryptionKey({
        JWT_SECRET: "legacy-jwt-key",
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
      }),
    ).toBe("credential-key");
  });

  it("keeps JWT as a legacy read fallback when no credential key is configured", () => {
    expect(getEncryptionKey({ JWT_SECRET: "legacy-jwt-key" })).toBe(
      "legacy-jwt-key",
    );
    expect(getCredentialEncryptionKey({ JWT_SECRET: "legacy-jwt-key" })).toBeUndefined();
  });

  it("requires the dedicated key for credential writes", () => {
    expect(() => requireEncryptionKey({ JWT_SECRET: "legacy-jwt-key" })).toThrow(
      ServiceUnavailableError,
    );
    expect(requireEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: "credential-key" })).toBe(
      "credential-key",
    );
  });

  it("prefers auth secrets for customer session token hashing", () => {
    expect(
      getCustomerSessionHashKey({
        BETTER_AUTH_SECRET: "better-auth-secret",
        JWT_SECRET: "jwt-secret",
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
      }),
    ).toBe("better-auth-secret");
    expect(getCustomerSessionHashKey({ JWT_SECRET: "jwt-secret" })).toBe("jwt-secret");
    expect(getCustomerSessionHashKey({ CREDENTIAL_ENCRYPTION_KEY: "credential-key" })).toBe("credential-key");
  });
});
