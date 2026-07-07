import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeStorefrontUrl: vi.fn(),
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import {
  buildAbsoluteStorefrontSeoUrl,
  buildResourceCanonicalSeoUrl,
  getAbsoluteStorefrontSeoBaseUrl,
  toAbsoluteStorefrontSeoUrl,
} from "./seo-base-url";

describe("SEO base URL helpers", () => {
  beforeEach(() => {
    mocks.getRuntimeStorefrontUrl.mockReset();
  });

  it("returns normalized absolute http(s) storefront URLs", () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://shop.example.com/");

    expect(getAbsoluteStorefrontSeoBaseUrl()).toBe("https://shop.example.com");
    expect(buildAbsoluteStorefrontSeoUrl("/products/fish")).toBe(
      "https://shop.example.com/products/fish",
    );
  });

  it("rejects missing, relative, and non-http storefront URLs", () => {
    for (const value of [
      "",
      "/demo",
      "ftp://shop.example.com",
      "https://shop.example.com/base",
      "https://shop.example.com?preview=1",
      "https://shop.example.com/#hash",
    ]) {
      mocks.getRuntimeStorefrontUrl.mockReturnValue(value);
      expect(getAbsoluteStorefrontSeoBaseUrl()).toBeNull();
      expect(buildAbsoluteStorefrontSeoUrl("/products/fish")).toBeNull();
    }
  });

  it("normalizes relative SEO asset URLs against the absolute storefront URL", () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://shop.example.com/");

    expect(toAbsoluteStorefrontSeoUrl("/cdn-cgi/image/x/products/fish.jpg")).toBe(
      "https://shop.example.com/cdn-cgi/image/x/products/fish.jpg",
    );
    expect(toAbsoluteStorefrontSeoUrl("https://cdn.example.com/fish.jpg")).toBe(
      "https://cdn.example.com/fish.jpg",
    );
    expect(toAbsoluteStorefrontSeoUrl("data:image/svg+xml,%3Csvg%3E")).toBeNull();
    expect(toAbsoluteStorefrontSeoUrl("//cdn.example.com/fish.jpg")).toBeNull();
    expect(toAbsoluteStorefrontSeoUrl("products\\fish.jpg")).toBeNull();
  });

  it("builds resource canonical URLs from resource-shaped path overrides only", () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://shop.example.com/");

    expect(
      buildResourceCanonicalSeoUrl("product", "/products/fish", "/products/hilsa"),
    ).toBe("https://shop.example.com/products/hilsa");
    expect(
      buildResourceCanonicalSeoUrl("product", "/products/fish", "/collections/fish"),
    ).toBe("https://shop.example.com/products/fish");
    expect(
      buildResourceCanonicalSeoUrl(
        "product",
        "/products/fish",
        "https://other.example/fish",
      ),
    ).toBe("https://shop.example.com/products/fish");
    expect(
      buildResourceCanonicalSeoUrl("product", "/products/fish", "/products/fish?ref=ad"),
    ).toBe("https://shop.example.com/products/fish");
  });
});
