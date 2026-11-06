import { describe, expect, it } from "vitest";
import {
  RUNTIME_SECRET_PURPOSES,
  deriveRuntimeSecret,
  deriveRuntimeSecrets,
  deriveRuntimeSecretsFromEnv,
  readMasterSecret,
  MASTER_SECRET_MIN_LENGTH,
} from "./runtime-secrets";
import type { RuntimeSecretName } from "./runtime-secrets";

describe("RUNTIME_SECRET_PURPOSES — domain-prefixed purpose labels", () => {
  it("all purposes are domain-prefixed (no bare purpose labels)", () => {
    for (const [name, purpose] of Object.entries(RUNTIME_SECRET_PURPOSES)) {
      expect(purpose).toMatch(/^[a-z]+:/);
    }
  });

  it("covers all RuntimeSecretName keys", () => {
    const names = Object.keys(RUNTIME_SECRET_PURPOSES) as RuntimeSecretName[];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(RUNTIME_SECRET_PURPOSES[name]).toBeDefined();
    }
  });

  it("has the expected payments refund metadata purpose", () => {
    expect(RUNTIME_SECRET_PURPOSES.REFUND_METADATA_HMAC).toBe("payments:refund:metadata:hmac:v1");
  });

  it("has the expected auth purposes", () => {
    expect(RUNTIME_SECRET_PURPOSES.BETTER_AUTH_SECRET).toBe("auth:better-auth-session:v1");
    expect(RUNTIME_SECRET_PURPOSES.JWT_SECRET).toBe("auth:jwt-signing:v1");
  });
});

describe("readMasterSecret", () => {
  it("returns null when env is null/undefined", () => {
    expect(readMasterSecret(null)).toBeNull();
    expect(readMasterSecret(undefined)).toBeNull();
  });

  it("returns null when SCALIUS_SECRET is missing", () => {
    expect(readMasterSecret({})).toBeNull();
  });

  it("returns null when SCALIUS_SECRET is too short", () => {
    const short = "a".repeat(MASTER_SECRET_MIN_LENGTH - 1);
    expect(readMasterSecret({ SCALIUS_SECRET: short })).toBeNull();
  });

  it("returns trimmed secret when long enough", () => {
    const secret = "a".repeat(MASTER_SECRET_MIN_LENGTH);
    expect(readMasterSecret({ SCALIUS_SECRET: `  ${secret}  ` })).toBe(secret);
  });
});

describe("deriveRuntimeSecret", () => {
  const master = "a".repeat(64);

  it("derives a 43-char base64url secret for a valid purpose", async () => {
    const derived = await deriveRuntimeSecret(master, "auth:test-purpose:v1");
    expect(typeof derived).toBe("string");
    expect(derived.length).toBe(43);
    // base64url: no +, /, or =
    expect(derived).not.toMatch(/[+/=]/);
  });

  it("throws when master secret is too short", async () => {
    await expect(deriveRuntimeSecret("short", "auth:test-purpose:v1")).rejects.toThrow();
  });

  it("derives different secrets for different purposes", async () => {
    const a = await deriveRuntimeSecret(master, "auth:purpose-a:v1");
    const b = await deriveRuntimeSecret(master, "auth:purpose-b:v1");
    expect(a).not.toBe(b);
  });

  it("derives the same secret for the same purpose (deterministic)", async () => {
    const a = await deriveRuntimeSecret(master, "auth:same-purpose:v1");
    const b = await deriveRuntimeSecret(master, "auth:same-purpose:v1");
    expect(a).toBe(b);
  });
});

describe("deriveRuntimeSecrets", () => {
  const master = "a".repeat(64);

  it("derives all runtime secrets from the master", async () => {
    const secrets = await deriveRuntimeSecrets(master);
    const names = Object.keys(RUNTIME_SECRET_PURPOSES) as RuntimeSecretName[];
    for (const name of names) {
      expect(secrets[name]).toBeDefined();
      expect(typeof secrets[name]).toBe("string");
      expect(secrets[name]!.length).toBe(43);
    }
  });

  it("throws when master secret is too short", async () => {
    await expect(deriveRuntimeSecrets("short")).rejects.toThrow();
  });
});

describe("deriveRuntimeSecretsFromEnv", () => {
  it("returns null when env has no valid master secret", async () => {
    const result = await deriveRuntimeSecretsFromEnv({});
    expect(result).toBeNull();
  });

  it("derives all secrets when env has a valid master secret", async () => {
    const master = "a".repeat(64);
    const result = await deriveRuntimeSecretsFromEnv({ SCALIUS_SECRET: master });
    expect(result).not.toBeNull();
    const names = Object.keys(RUNTIME_SECRET_PURPOSES) as RuntimeSecretName[];
    for (const name of names) {
      expect(result![name]).toBeDefined();
    }
  });
});
