import { describe, expect, it } from "vitest";
import {
  canonicalizeStorefrontHtmlCachePath,
  hasStorefrontProductVariantSelectionParams,
  isStorefrontTrackingQueryParam,
} from "./storefront-cache-path";

describe("storefront HTML cache path canonicalization", () => {
  it("canonicalizes product selection and tracking variants to one HTML path", () => {
    expect(canonicalizeStorefrontHtmlCachePath("/products/fish?size=m")).toBe(
      "/products/fish",
    );
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/products/fish?color=red&utm_source=ad&gclid=google&gbraid=ios&wbraid=web&msclkid=bing&ttclid=tiktok",
      ),
    ).toBe("/products/fish");
  });

  it("detects product variant selection params, including empty values", () => {
    expect(
      hasStorefrontProductVariantSelectionParams(
        new URL("https://store.example/products/fish?size=m"),
      ),
    ).toBe(true);
    expect(
      hasStorefrontProductVariantSelectionParams(
        new URL("https://store.example/products/fish?color="),
      ),
    ).toBe(true);
    expect(
      hasStorefrontProductVariantSelectionParams(
        new URL("https://store.example/products/fish?utm_source=ad"),
      ),
    ).toBe(false);
    expect(
      hasStorefrontProductVariantSelectionParams(
        new URL("https://store.example/categories/fish?size=m"),
      ),
    ).toBe(false);
  });

  it("sorts surviving query params and elides listing defaults", () => {
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/categories/drinks?sortBy=newest&page=1&brand=Fresh&q=%20hilsa%20%20fish%20",
      ),
    ).toBe("/categories/drinks?brand=Fresh&q=hilsa+fish");
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/collections/featured?sortBy=newest&page=1&brand=Fresh",
      ),
    ).toBe("/collections/featured?brand=Fresh");
  });

  it("ignores current ad click identifiers on listing HTML paths", () => {
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/search?q=fish&fbclid=meta&gclid=google&gbraid=ios&wbraid=web&msclkid=bing&ttclid=tiktok",
      ),
    ).toBe("/search?q=fish");
  });

  it("strips the whole tracking allowlist, including every utm_* tag, from any HTML path", () => {
    const tracking =
      "utm_source=fb&utm_medium=cpc&utm_campaign=eid&utm_id=9&utm_source_platform=meta&UTM_TERM=x" +
      "&fbclid=a&gclid=b&gbraid=c&wbraid=d&gad_source=1&gad_campaignid=2&srsltid=e&msclkid=f" +
      "&ttclid=g&yclid=h&mc_cid=i&mc_eid=j&igshid=k&_ga=2.1.3";
    expect(canonicalizeStorefrontHtmlCachePath(`/products/fish?${tracking}`)).toBe("/products/fish");
    expect(canonicalizeStorefrontHtmlCachePath(`/?${tracking}`)).toBe("/");
    expect(canonicalizeStorefrontHtmlCachePath(`/categories/drinks?${tracking}&brand=Fresh&page=2`))
      .toBe("/categories/drinks?brand=Fresh&page=2");
    expect(canonicalizeStorefrontHtmlCachePath(`/about-us?${tracking}`)).toBe("/about-us");
  });

  it("never strips functional or unknown parameters", () => {
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/products/fish?variant=var_1&gclid=b&utm=keep&source=keep&ga=keep&campaign=keep&tracking=keep",
      ),
    ).toBe("/products/fish?campaign=keep&ga=keep&source=keep&tracking=keep&utm=keep&variant=var_1");
    for (const key of ["q", "page", "sortBy", "limit", "brand", "minPrice", "option.size", "display-size.min"]) {
      expect(isStorefrontTrackingQueryParam(key)).toBe(false);
    }
  });

  it("preserves repeated values so multi-select HTML cache identities stay exact", () => {
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/search?q=apple&q=banana&sortBy=price-desc&sortBy=newest&page=2&page=1",
      ),
    ).toBe("/search?page=2&q=apple&q=banana&sortBy=price-desc");
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/categories/drinks?brand=Fresh&brand=Local&color=Red&color=Blue",
      ),
    ).toBe(
      "/categories/drinks?brand=Fresh&brand=Local&color=Blue&color=Red",
    );
  });

  it("rejects absolute, protocol-relative, and empty paths", () => {
    expect(canonicalizeStorefrontHtmlCachePath("")).toBeNull();
    expect(canonicalizeStorefrontHtmlCachePath("https://evil.example/products/fish")).toBeNull();
    expect(canonicalizeStorefrontHtmlCachePath("//evil.example/products/fish")).toBeNull();
    expect(canonicalizeStorefrontHtmlCachePath("/products/fish")).toBe("/products/fish");
  });
});
