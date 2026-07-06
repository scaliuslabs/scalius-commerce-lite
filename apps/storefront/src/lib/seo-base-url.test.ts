import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeStorefrontUrl: vi.fn(),
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import {
  buildAbsoluteStorefrontSeoUrl,
  getAbsoluteStorefrontSeoBaseUrl,
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
    for (const value of ["", "/demo", "ftp://shop.example.com"]) {
      mocks.getRuntimeStorefrontUrl.mockReturnValue(value);
      expect(getAbsoluteStorefrontSeoBaseUrl()).toBeNull();
      expect(buildAbsoluteStorefrontSeoUrl("/products/fish")).toBeNull();
    }
  });
});
