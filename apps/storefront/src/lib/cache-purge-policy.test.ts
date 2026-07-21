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

  it("keeps CMS page-family purges generation-scoped", () => {
    const input = {
      groups: ["pages"],
      prefixes: [
        "page_slug_",
        "page_render_",
        "all_pages_",
        "sitemap_pages_",
        "page_html_",
      ],
      bumpVersion: false,
    };

    expect(shouldBumpCacheVersionForSelectivePurge(input)).toBe(false);
    expect(shouldWarmCriticalCachesForSelectivePurge(input)).toBe(false);
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
      groups: ["pages"],
      prefixes: ["page_render_about-us_"],
      htmlPaths: ["/about-us"],
      bumpVersion: false,
    })).toBe(false);
    expect(shouldWarmCriticalCachesForSelectivePurge({
      groups: ["pages"],
      prefixes: ["page_render_about-us_"],
      htmlPaths: ["/about-us"],
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
