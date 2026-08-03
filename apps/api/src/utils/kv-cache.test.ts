import { describe, expect, it, vi } from "vitest";

import { getCache, setCache } from "./kv-cache";

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

describe("KV cache binding isolation", () => {
  it("uses only the binding supplied by the current request", async () => {
    const first = kvStore();
    const second = kvStore();

    await setCache("merchant", { id: "first" }, 60, first.binding);
    await setCache("merchant", { id: "second" }, 60, second.binding);

    await expect(getCache("merchant", first.binding)).resolves.toEqual({
      id: "first",
    });
    await expect(getCache("merchant", second.binding)).resolves.toEqual({
      id: "second",
    });
  });

  it("does not serve local fallback data after a bound KV read fails", async () => {
    await setCache("merchant", { id: "local-only" }, 60);
    const unavailable = {
      get: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
    } as unknown as KVNamespace;

    await expect(getCache("merchant", unavailable)).resolves.toBeNull();
  });
});
