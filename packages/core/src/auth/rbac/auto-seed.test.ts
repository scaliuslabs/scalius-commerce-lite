import { describe, expect, it, vi } from "vitest";
import {
  getRbacSeedCacheKey,
  isRbacSeedCacheCurrent,
  markRbacSeedCacheCurrent,
} from "./auto-seed";

describe("RBAC seed cache marker", () => {
  it("uses a compact versioned key derived from the seed definitions", () => {
    expect(getRbacSeedCacheKey()).toMatch(/^rbac:seed-current:v1:[a-f0-9]{8}$/);
  });

  it("reads and writes the current marker through KV", async () => {
    const values = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as Pick<KVNamespace, "get" | "put">;

    await expect(isRbacSeedCacheCurrent(kv)).resolves.toBe(false);
    await markRbacSeedCacheCurrent(kv);
    await expect(isRbacSeedCacheCurrent(kv)).resolves.toBe(true);

    expect(kv.put).toHaveBeenCalledWith(getRbacSeedCacheKey(), "1", {
      expirationTtl: 21600,
    });
  });
});
