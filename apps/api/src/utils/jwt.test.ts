import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateToken,
  getTokenStats,
  revokeToken,
  verifyToken,
} from "./jwt";

describe("JWT secret source", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs only with the JWT_SECRET carried by the composed runtime env", () => {
    vi.stubEnv("JWT_SECRET", "process-env-secret-must-never-be-used-here");

    expect(() => generateToken({ id: "system" }, "1h", {})).toThrow(
      "Failed to generate authentication token",
    );
    expect(() => generateToken({ id: "system" }, "1h", { JWT_SECRET: "" })).toThrow(
      "Failed to generate authentication token",
    );
    expect(getTokenStats({})).toMatchObject({ isConfigured: false });
    expect(
      generateToken({ id: "system" }, "1h", {
        JWT_SECRET: "runtime-env-secret-with-at-least-thirty-two-chars",
      }),
    ).toEqual(expect.any(String));
  });

  it("rejects verification when the composed env has no JWT_SECRET", async () => {
    vi.stubEnv("JWT_SECRET", "process-env-secret-must-never-be-used-here");
    const secret = "runtime-env-secret-with-at-least-thirty-two-chars";
    const token = generateToken({ id: "system" }, "1h", { JWT_SECRET: secret });
    const kv = {
      get: vi.fn(async () => null),
    } as unknown as KVNamespace;

    await expect(verifyToken(token, { CACHE: kv })).rejects.toThrow(
      "JWT_SECRET is not available in the runtime env",
    );
    await expect(verifyToken(token, { JWT_SECRET: secret, CACHE: kv })).resolves.toMatchObject({
      id: "system",
    });
  });
});

function kvStore() {
  const values = new Map<string, string>();
  return {
    values,
    binding: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as KVNamespace,
  };
}

describe("JWT blacklist binding isolation", () => {
  it("revokes only in the explicitly supplied KV namespace", async () => {
    const secret = "test-secret-with-at-least-thirty-two-characters";
    const token = generateToken({ id: "system" }, "1h", {
      JWT_SECRET: secret,
    });
    const first = kvStore();
    const second = kvStore();

    await expect(verifyToken(token, {
      JWT_SECRET: secret,
      CACHE: first.binding,
    })).resolves.toMatchObject({ id: "system" });

    await revokeToken(token, first.binding);

    await expect(verifyToken(token, {
      JWT_SECRET: secret,
      CACHE: first.binding,
    })).rejects.toThrow("Token has been revoked");
    await expect(verifyToken(token, {
      JWT_SECRET: secret,
      CACHE: second.binding,
    })).resolves.toMatchObject({ id: "system" });
    expect([...first.values.keys()]).toHaveLength(1);
    expect([...first.values.keys()][0]).not.toContain(token);
  });

  it("rejects authentication when the shared revocation store is unavailable", async () => {
    const secret = "test-secret-with-at-least-thirty-two-characters";
    const token = generateToken({ id: "system" }, "1h", {
      JWT_SECRET: secret,
    });
    const unavailable = {
      get: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
    } as unknown as KVNamespace;

    await expect(verifyToken(token, {
      JWT_SECRET: secret,
      CACHE: unavailable,
    })).rejects.toThrow(
      "Authentication revocation state is temporarily unavailable.",
    );
  });
});
