import { describe, expect, it, vi } from "vitest";

import {
  generateToken,
  revokeToken,
  verifyToken,
} from "./jwt";

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
