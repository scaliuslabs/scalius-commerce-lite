import { describe, expect, it } from "vitest";

import {
  MASTER_SECRET_MIN_LENGTH,
  MASTER_SECRET_NAME,
  RUNTIME_SECRET_PURPOSES,
  deriveRuntimeSecret,
  deriveRuntimeSecrets,
  deriveRuntimeSecretsFromEnv,
  describeMissingMasterSecret,
  readMasterSecret,
} from "./runtime-secrets";

const MASTER = "master-secret-for-tests-0123456789abcdef";
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

describe("readMasterSecret", () => {
  it("returns the trimmed master secret when it meets the minimum length", () => {
    expect(readMasterSecret({ SCALIUS_SECRET: `  ${MASTER}\n` })).toBe(MASTER);
  });

  it("rejects secrets shorter than the minimum length after trimming", () => {
    const short = "x".repeat(MASTER_SECRET_MIN_LENGTH - 1);
    expect(readMasterSecret({ SCALIUS_SECRET: short })).toBeNull();
    expect(readMasterSecret({ SCALIUS_SECRET: `${short}   ` })).toBeNull();
    expect(readMasterSecret({ SCALIUS_SECRET: "x".repeat(MASTER_SECRET_MIN_LENGTH) })).toBe(
      "x".repeat(MASTER_SECRET_MIN_LENGTH),
    );
  });

  it("rejects missing, empty, and non-string values", () => {
    expect(readMasterSecret(undefined)).toBeNull();
    expect(readMasterSecret(null)).toBeNull();
    expect(readMasterSecret({})).toBeNull();
    expect(readMasterSecret({ SCALIUS_SECRET: "" })).toBeNull();
    expect(readMasterSecret({ SCALIUS_SECRET: 12345678 })).toBeNull();
    expect(readMasterSecret({ SCALIUS_SECRET: { value: MASTER } })).toBeNull();
  });

  it("names the master secret and its minimum length in the operator message", () => {
    const message = describeMissingMasterSecret();
    expect(MASTER_SECRET_NAME).toBe("SCALIUS_SECRET");
    expect(message).toContain(MASTER_SECRET_NAME);
    expect(message).toContain(String(MASTER_SECRET_MIN_LENGTH));
  });
});

describe("deriveRuntimeSecret", () => {
  it("is deterministic for the same master secret and purpose", async () => {
    const first = await deriveRuntimeSecret(MASTER, RUNTIME_SECRET_PURPOSES.JWT_SECRET);
    const second = await deriveRuntimeSecret(MASTER, RUNTIME_SECRET_PURPOSES.JWT_SECRET);
    expect(first).toBe(second);
  });

  it("produces a 43 character base64url value with no padding", async () => {
    const derived = await deriveRuntimeSecret(MASTER, RUNTIME_SECRET_PURPOSES.API_TOKEN);
    expect(derived).toMatch(BASE64URL_43);
    expect(derived).not.toContain("=");
    expect(derived).not.toContain("+");
    expect(derived).not.toContain("/");
  });

  it("separates purposes so no two runtime secrets share a value", async () => {
    const purposes = Object.values(RUNTIME_SECRET_PURPOSES);
    const values = await Promise.all(
      purposes.map((purpose) => deriveRuntimeSecret(MASTER, purpose)),
    );
    expect(new Set(values).size).toBe(purposes.length);
    for (const value of values) {
      expect(value).not.toBe(MASTER);
      expect(value).not.toContain(MASTER);
    }
  });

  it("changes every derived value when the master secret rotates", async () => {
    const rotatedMaster = `${MASTER}-rotated`;
    for (const purpose of Object.values(RUNTIME_SECRET_PURPOSES)) {
      const original = await deriveRuntimeSecret(MASTER, purpose);
      const rotated = await deriveRuntimeSecret(rotatedMaster, purpose);
      expect(rotated).not.toBe(original);
    }
  });

  it("rejects a master secret shorter than the minimum length", async () => {
    await expect(
      deriveRuntimeSecret("too-short", RUNTIME_SECRET_PURPOSES.BETTER_AUTH_SECRET),
    ).rejects.toThrow(describeMissingMasterSecret());
  });
});

describe("deriveRuntimeSecrets", () => {
  it("derives one value per runtime secret name matching single-purpose derivation", async () => {
    const derived = await deriveRuntimeSecrets(MASTER);
    const names = Object.keys(RUNTIME_SECRET_PURPOSES) as Array<
      keyof typeof RUNTIME_SECRET_PURPOSES
    >;

    expect(Object.keys(derived).sort()).toEqual([...names].sort());
    expect(names).toEqual([
      "BETTER_AUTH_SECRET",
      "JWT_SECRET",
      "API_TOKEN",
      "PURGE_TOKEN",
      "AGENT_TOKEN_PEPPER",
      "CUSTOMER_SESSION_HASH_KEY",
    ]);
    for (const name of names) {
      expect(derived[name]).toMatch(BASE64URL_43);
      expect(derived[name]).toBe(
        await deriveRuntimeSecret(MASTER, RUNTIME_SECRET_PURPOSES[name]),
      );
    }
  });
});

describe("deriveRuntimeSecretsFromEnv", () => {
  it("derives the full set from an installed master secret", async () => {
    const derived = await deriveRuntimeSecretsFromEnv({ SCALIUS_SECRET: `${MASTER} ` });
    expect(derived).toEqual(await deriveRuntimeSecrets(MASTER));
  });

  it("returns null instead of guessing when the master secret is not installed", async () => {
    await expect(deriveRuntimeSecretsFromEnv({})).resolves.toBeNull();
    await expect(deriveRuntimeSecretsFromEnv(undefined)).resolves.toBeNull();
    await expect(
      deriveRuntimeSecretsFromEnv({ SCALIUS_SECRET: "short" }),
    ).resolves.toBeNull();
  });
});
