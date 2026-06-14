import { describe, expect, it, vi } from "vitest";
import { resolveStorefrontCacheVersion } from "./cache-version";

describe("resolveStorefrontCacheVersion", () => {
  it("uses an existing cache version without writing a fallback", async () => {
    const store = {
      get: vi.fn(async () => "42"),
      put: vi.fn(async () => undefined),
    };

    const result = await resolveStorefrontCacheVersion({
      store,
      key: "v_storefront.scalius.com",
      timeoutMs: 100,
    });

    expect(result).toEqual({
      status: "available",
      version: "42",
      initialized: false,
    });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("initializes version 1 only when KV successfully returns a missing value", async () => {
    const waitUntil = vi.fn();
    const store = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };

    const result = await resolveStorefrontCacheVersion({
      store,
      key: "v_storefront.scalius.com",
      timeoutMs: 100,
      waitUntil,
    });

    expect(result).toEqual({
      status: "available",
      version: "1",
      initialized: true,
    });
    expect(store.put).toHaveBeenCalledWith("v_storefront.scalius.com", "1");
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("does not write version 1 when KV throws", async () => {
    const store = {
      get: vi.fn(async () => {
        throw new Error("temporary outage");
      }),
      put: vi.fn(async () => undefined),
    };

    const result = await resolveStorefrontCacheVersion({
      store,
      key: "v_storefront.scalius.com",
      timeoutMs: 100,
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "temporary outage",
    });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("does not write version 1 when KV times out", async () => {
    const store = {
      get: vi.fn(() => new Promise<string | null>(() => {})),
      put: vi.fn(async () => undefined),
    };

    const result = await resolveStorefrontCacheVersion({
      store,
      key: "v_storefront.scalius.com",
      timeoutMs: 1,
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "KV lookup timeout",
    });
    expect(store.put).not.toHaveBeenCalled();
  });
});
