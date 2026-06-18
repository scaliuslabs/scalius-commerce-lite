import { describe, expect, it } from "vitest";
import {
  shouldBumpCacheVersionForSelectivePurge,
  shouldWarmCriticalCachesForSelectivePurge,
} from "./cache-purge-policy";

describe("selective cache purge policy", () => {
  it("bumps the cache version for prefix-only purges so L2 Cache API keys move", () => {
    expect(shouldBumpCacheVersionForSelectivePurge({
      prefixes: ["global_shipping_methods"],
      bumpVersion: false,
    })).toBe(true);
  });

  it("warms critical HTML caches for prefix-only purges because the global version moved", () => {
    expect(shouldWarmCriticalCachesForSelectivePurge({
      prefixes: ["global_shipping_methods"],
      bumpVersion: false,
    })).toBe(true);
  });

  it("keeps prefix purges local when exact HTML targets are supplied", () => {
    expect(shouldBumpCacheVersionForSelectivePurge({
      prefixes: ["widgets_scope_product_prod_1"],
      htmlPaths: ["/products/fish"],
      bumpVersion: false,
    })).toBe(false);
    expect(shouldWarmCriticalCachesForSelectivePurge({
      prefixes: ["widgets_scope_product_prod_1"],
      htmlPaths: ["/products/fish"],
      bumpVersion: false,
    })).toBe(false);
  });

  it("warms critical caches when the caller marks the purge as HTML-affecting", () => {
    expect(shouldBumpCacheVersionForSelectivePurge({
      prefixes: [],
      bumpVersion: true,
    })).toBe(true);
    expect(shouldWarmCriticalCachesForSelectivePurge({
      prefixes: [],
      bumpVersion: true,
    })).toBe(true);
  });
});
