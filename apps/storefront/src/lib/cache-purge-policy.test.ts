import { describe, expect, it } from "vitest";
import {
  shouldBumpCacheVersionForSelectivePurge,
  shouldWarmCriticalCachesForSelectivePurge,
} from "./cache-purge-policy";

describe("selective cache purge policy", () => {
  it("keeps checkout-only prefix purges generation-scoped", () => {
    expect(shouldBumpCacheVersionForSelectivePurge({
      groups: ["checkout"],
      prefixes: [
        "global_shipping_cities",
        "shipping_zones_",
        "shipping_areas_",
        "global_shipping_methods",
        "checkout_config",
        "global_checkout_language",
      ],
      bumpVersion: false,
    })).toBe(false);
    expect(shouldWarmCriticalCachesForSelectivePurge({
      groups: ["checkout"],
      prefixes: [
        "global_shipping_cities",
        "shipping_zones_",
        "shipping_areas_",
        "global_shipping_methods",
        "checkout_config",
        "global_checkout_language",
      ],
      bumpVersion: false,
    })).toBe(false);
  });

  it("bumps and warms unknown prefix-only purges so broad L2 data cannot stale", () => {
    expect(shouldWarmCriticalCachesForSelectivePurge({
      groups: ["unknown"],
      prefixes: ["unknown_prefix_"],
      bumpVersion: false,
    })).toBe(true);
    expect(shouldBumpCacheVersionForSelectivePurge({
      groups: ["unknown"],
      prefixes: ["unknown_prefix_"],
      bumpVersion: false,
    })).toBe(true);
  });

  it("keeps prefix purges local when exact HTML targets are supplied", () => {
    expect(shouldBumpCacheVersionForSelectivePurge({
      groups: ["widgets"],
      prefixes: ["widgets_scope_product_prod_1"],
      htmlPaths: ["/products/fish"],
      bumpVersion: false,
    })).toBe(false);
    expect(shouldWarmCriticalCachesForSelectivePurge({
      groups: ["widgets"],
      prefixes: ["widgets_scope_product_prod_1"],
      htmlPaths: ["/products/fish"],
      bumpVersion: false,
    })).toBe(false);
  });

  it("warms critical caches when the caller marks the purge as HTML-affecting", () => {
    expect(shouldBumpCacheVersionForSelectivePurge({
      groups: ["checkout"],
      prefixes: ["checkout_config"],
      bumpVersion: true,
    })).toBe(true);
    expect(shouldWarmCriticalCachesForSelectivePurge({
      groups: ["checkout"],
      prefixes: ["checkout_config"],
      bumpVersion: true,
    })).toBe(true);
  });

  it("falls back to global bump when mixed groups include checkout prefixes", () => {
    expect(shouldBumpCacheVersionForSelectivePurge({
      groups: ["checkout", "layout"],
      prefixes: ["checkout_config"],
      bumpVersion: false,
    })).toBe(true);
  });
});
