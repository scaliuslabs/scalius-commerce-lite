import { describe, expect, it } from "vitest";
import { httpsRedirectResponse } from "./storefront-origin";

describe("httpsRedirectResponse", () => {
  it("permanently redirects plain HTTP for a public host, keeping path and query", () => {
    const response = httpsRedirectResponse(new Request("http://shop.example.com/products/tea?variant=v1"));
    expect(response?.status).toBe(308);
    expect(response?.headers.get("Location")).toBe("https://shop.example.com/products/tea?variant=v1");
  });

  it.each([
    "https://shop.example.com/",
    "http://localhost:4322/",
    "http://127.0.0.1:8787/",
    "http://192.168.0.10:4322/",
    "http://[::1]:4322/",
    "http://store.localhost/",
  ])("leaves %s alone", (url) => {
    expect(httpsRedirectResponse(new Request(url))).toBeNull();
  });
});
