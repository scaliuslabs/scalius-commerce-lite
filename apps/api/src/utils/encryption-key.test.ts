import { describe, expect, it } from "vitest";
import {
  getCredentialEncryptionKey,
  getCustomerSessionHashKey,
  requireEncryptionKey,
} from "./encryption-key";
import { ServiceUnavailableError } from "./api-error";

describe("encryption key helpers", () => {
  it("reads the credential encryption key from CREDENTIAL_ENCRYPTION_KEY only", () => {
    expect(
      getCredentialEncryptionKey({
        JWT_SECRET: "jwt-secret",
        BETTER_AUTH_SECRET: "better-auth-secret",
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
      }),
    ).toBe("credential-key");
    expect(getCredentialEncryptionKey({ JWT_SECRET: "jwt-secret" })).toBeUndefined();
    expect(getCredentialEncryptionKey({ BETTER_AUTH_SECRET: "better-auth-secret" })).toBeUndefined();
    expect(getCredentialEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: "" })).toBeUndefined();
    expect(getCredentialEncryptionKey({})).toBeUndefined();
  });

  it("requires the dedicated key for credential writes", () => {
    expect(() => requireEncryptionKey({ JWT_SECRET: "jwt-secret" })).toThrow(
      ServiceUnavailableError,
    );
    expect(() => requireEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: "" })).toThrow(
      ServiceUnavailableError,
    );
    expect(requireEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: "credential-key" })).toBe(
      "credential-key",
    );
  });

  it("reads the customer session hash key from CUSTOMER_SESSION_HASH_KEY only", () => {
    expect(
      getCustomerSessionHashKey({
        BETTER_AUTH_SECRET: "better-auth-secret",
        JWT_SECRET: "jwt-secret",
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
        CUSTOMER_SESSION_HASH_KEY: "customer-session-hash-key",
      }),
    ).toBe("customer-session-hash-key");
    expect(getCustomerSessionHashKey({ BETTER_AUTH_SECRET: "better-auth-secret" })).toBeUndefined();
    expect(getCustomerSessionHashKey({ JWT_SECRET: "jwt-secret" })).toBeUndefined();
    expect(getCustomerSessionHashKey({ CREDENTIAL_ENCRYPTION_KEY: "credential-key" })).toBeUndefined();
    expect(getCustomerSessionHashKey({ CUSTOMER_SESSION_HASH_KEY: "" })).toBeUndefined();
  });
});
