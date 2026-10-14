// @vitest-environment node
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pageKind, STOREFRONT_STATIC_SEGMENTS } from "./page-kind";

describe("pageKind", () => {
  it("names each public page kind", () => {
    expect(pageKind("/")).toBe("home");
    expect(pageKind("/pages/spring-sale")).toBe("landing");
    expect(pageKind("/products/linen-shirt")).toBe("product");
    for (const path of ["/categories", "/categories/bags", "/collections/col_1", "/brands/acme"]) expect(pageKind(path), path).toBe("listing");
    expect(pageKind("/search")).toBe("search");
    expect(pageKind("/search/")).toBe("search");
    expect(pageKind("/cart")).toBe("cart");
    expect(pageKind("/cart/")).toBe("cart");
  });

  it("calls a single-segment CMS path a page", () => {
    for (const path of ["/about-us", "/shipping-policy", "/faq", "/about-us/"]) expect(pageKind(path), path).toBe("page");
  });

  it("never calls the checkout or another buyer page a cart or a page", () => {
    for (const path of [
      "/checkout", "/checkout/quick", "/order-success", "/account", "/account/orders/ord_1", "/payment-recovery", "/track-order", "/buy/linen-shirt",
    ]) {
      expect(pageKind(path), path).toBe("other");
    }
  });

  it("leaves routes that are not catalog or CMS pages as other", () => {
    for (const path of ["/blog", "/blog/hello", "/robots.txt", "/sitemap.xml", "/sitemap-products.xml", "/api/product-feed.xml", "/apps/acme.wishlist/wishlist", "/a/b", "/About"]) {
      expect(pageKind(path), path).toBe("other");
    }
  });

  it("lists every top-level slug-shaped route under src/pages, so none reads as a CMS page", () => {
    const dir = fileURLToPath(new URL("../../pages", import.meta.url));
    const routes = new Set<string>();
    for (const entry of readdirSync(dir)) {
      const name = entry.replace(/\.(?:astro|ts)$/, "");
      // index is the home page; the other entries are routes of their own.
      if (name !== "index" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) routes.add(name);
    }
    expect([...routes].sort()).toEqual([...STOREFRONT_STATIC_SEGMENTS].sort());
  });
});
