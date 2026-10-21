// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { browserApiUrl } from "./browser-url";

describe("browserApiUrl", () => {
  afterEach(() => {
    delete window.__API_BASE_URL__;
  });

  it("joins the injected API URL and a path, as the SSR transport's createApiUrl does", () => {
    window.__API_BASE_URL__ = "https://api.example.test/api/v1";
    expect(browserApiUrl("/search?q=rice")).toBe("https://api.example.test/api/v1/search?q=rice");
    expect(browserApiUrl("categories/rice/products")).toBe("https://api.example.test/api/v1/categories/rice/products");
  });

  it("fails closed when the page carries no API URL", () => {
    expect(() => browserApiUrl("/checkout/config")).toThrow(/PUBLIC_API_URL is not configured/);
    window.__API_BASE_URL__ = "";
    expect(() => browserApiUrl("/checkout/config")).toThrow(/PUBLIC_API_URL is not configured/);
  });
});
