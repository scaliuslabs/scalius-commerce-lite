import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getStripeSettings,
  invalidatePaymentMethodsCache,
  invalidatePolarCache,
  invalidateSSLCommerzCache,
  invalidateStripeCache,
} from "./gateway-settings";

function createRejectingDeleteKv(): KVNamespace {
  return {
    delete: vi.fn().mockRejectedValue(new Error("kv unavailable")),
  } as unknown as KVNamespace;
}

function createDbReturningNoSettings() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => [],
        }),
      }),
    }),
  };
}

describe("payment gateway settings cache cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["stripe", invalidateStripeCache, "gw:stripe"],
    ["sslcommerz", invalidateSSLCommerzCache, "gw:sslcommerz"],
    ["polar", invalidatePolarCache, "gw:polar"],
    ["payment methods", invalidatePaymentMethodsCache, "gw:payment_methods"],
  ])("does not throw when %s legacy KV cleanup fails", async (_label, invalidate, key) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = createRejectingDeleteKv();

    await expect(invalidate(kv)).resolves.toBeUndefined();

    expect(kv.delete).toHaveBeenCalledWith(key);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Legacy KV credential cache delete failed for ${key}`),
      "kv unavailable",
    );
  });

  it("does not throw when stale Stripe KV lookup fails during migration cleanup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = {
      get: vi.fn().mockRejectedValue(new Error("kv lookup unavailable")),
      delete: vi.fn(),
    } as unknown as KVNamespace;

    await expect(
      getStripeSettings(createDbReturningNoSettings() as never, kv),
    ).resolves.toBeNull();

    expect(kv.get).toHaveBeenCalledWith("gw:stripe");
    expect(kv.delete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Legacy KV credential cache lookup failed for gw:stripe"),
      "kv lookup unavailable",
    );
  });
});
