import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";

import { isPrivateStorefrontPathname } from "./cache-policy";
import {
  applyStorefrontPrefetchPolicyToHtml,
  getStorefrontPrefetchAttribute,
} from "./prefetch-policy";

describe("storefront navigation prefetch policy", () => {
  it.each([
    "/account",
    "/account/orders/order_123",
    "/buy/example-product",
    "/cart",
    "/checkout",
    "/order-success?orderId=order_123",
    "/payment-recovery?orderId=order_123",
    "/theme-preview/example-theme",
  ])("disables prefetch for private commerce destination %s", (href) => {
    expect(getStorefrontPrefetchAttribute(href)).toBe("false");
  });

  it.each([
    "/",
    "/products/example-product",
    "/products/example-product?variant=sku_123",
    "/categories/shoes?sort=price-asc",
    "/collections/featured",
    "/search?q=shoe",
    "/blog/new-arrivals",
  ])("leaves public catalog/content destination %s eligible", (href) => {
    expect(getStorefrontPrefetchAttribute(href)).toBeUndefined();
  });

  it.each([
    "/products/example-product?size=large",
    "/products/example-product?color=blue",
    "https://shop.example/products/example-product?size=large&color=blue",
  ])("does not prefetch uncached product option destination %s", (href) => {
    expect(getStorefrontPrefetchAttribute(href)).toBe("false");
  });

  it("matches private route segments without swallowing public lookalikes", () => {
    expect(isPrivateStorefrontPathname("/account/orders/order_123")).toBe(true);
    expect(isPrivateStorefrontPathname("/accounting")).toBe(false);
    expect(isPrivateStorefrontPathname("/products/cart")).toBe(false);
  });

  it("ignores empty and malformed destinations", () => {
    expect(getStorefrontPrefetchAttribute(null)).toBeUndefined();
    expect(getStorefrontPrefetchAttribute(undefined)).toBeUndefined();
    expect(getStorefrontPrefetchAttribute("http://[invalid")).toBeUndefined();
  });

  it("conservatively disables unresolved query-only links", () => {
    expect(getStorefrontPrefetchAttribute("?sort=newest")).toBe("false");
    expect(
      getStorefrontPrefetchAttribute(
        "?sort=newest",
        "https://shop.example/categories/shoes",
      ),
    ).toBeUndefined();
    expect(
      getStorefrontPrefetchAttribute(
        "?size=large",
        "https://shop.example/products/example-product",
      ),
    ).toBe("false");
    expect(
      getStorefrontPrefetchAttribute(
        "?step=delivery",
        "https://shop.example/cart",
      ),
    ).toBe("false");
  });

  it("does not annotate a truly cross-origin destination", () => {
    expect(
      getStorefrontPrefetchAttribute(
        "https://external.example/account",
        "https://shop.example/products/example-product",
      ),
    ).toBeUndefined();
    expect(
      getStorefrontPrefetchAttribute(
        "https://shop.example/account",
        "https://shop.example/products/example-product",
      ),
    ).toBe("false");
  });

  it("marks private links embedded in merchant-authored HTML", () => {
    const html = [
      '<a class="catalog" href="/products/example-product">Product</a>',
      '<a href="/cart" data-astro-prefetch="hover">Cart</a>',
      "<a href='/payment-recovery?orderId=order_123'>Recover</a>",
      '<a href="/products/example-product?variant=sku_123&amp;color=blue">Blue</a>',
    ].join("");

    expect(applyStorefrontPrefetchPolicyToHtml(html)).toBe(
      [
        '<a class="catalog" href="/products/example-product">Product</a>',
        '<a href="/cart" data-astro-prefetch="false">Cart</a>',
        '<a href="/payment-recovery?orderId=order_123" data-astro-prefetch="false">Recover</a>',
        '<a href="/products/example-product?variant=sku_123&amp;color=blue" data-astro-prefetch="false">Blue</a>',
      ].join(""),
    );
  });

  it("resolves query-only merchant links only when the real page URL is known", () => {
    expect(
      applyStorefrontPrefetchPolicyToHtml(
        '<a href="?sort=price-asc">Sort</a>',
        "https://shop.example/categories/shoes",
      ),
    ).toBe('<a href="?sort=price-asc">Sort</a>');
    expect(
      applyStorefrontPrefetchPolicyToHtml(
        '<a href="?size=large">Large</a>',
        "https://shop.example/products/example-product",
      ),
    ).toBe(
      '<a href="?size=large" data-astro-prefetch="false">Large</a>',
    );
  });

  it("uses parsed attributes without corrupting or trusting attribute-like text", () => {
    const html = sanitizeHtml([
      '<a title="fake href=&quot;/products/public&quot;" href="/cart">Cart</a>',
      '<a class="x data-astro-prefetch=hover" href="/payment-recovery">Recover</a>',
      '<a title="fake data-astro-prefetch=&quot;hover&quot;" href="/account">Account</a>',
      '<a title="fake href=&quot;/cart&quot;" href="/products/public">Product</a>',
    ].join(""));

    const output = applyStorefrontPrefetchPolicyToHtml(
      html,
      "https://shop.example/products/current",
    );

    expect(output).toContain(
      '<a title="fake href=&quot;/products/public&quot;" href="/cart" data-astro-prefetch="false">Cart</a>',
    );
    expect(output).toContain(
      '<a class="x data-astro-prefetch=hover" href="/payment-recovery" data-astro-prefetch="false">Recover</a>',
    );
    expect(output).toContain(
      '<a title="fake data-astro-prefetch=&quot;hover&quot;" href="/account" data-astro-prefetch="false">Account</a>',
    );
    expect(output).toContain(
      '<a title="fake href=&quot;/cart&quot;" href="/products/public">Product</a>',
    );
  });
});
