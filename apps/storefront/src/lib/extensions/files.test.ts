import { describe, expect, it } from "vitest";
import { extensionFileCacheKey } from "./files";

describe("extensionFileCacheKey", () => {
  it("never shares an app file's cache entry between stores", () => {
    const release = "a".repeat(64);
    const a = extensionFileCacheKey("https://a.example", "acme.theme", release, "storefront.js");
    const b = extensionFileCacheKey("https://b.example", "acme.theme", release, "storefront.js");
    expect(a).not.toBe(b);
    expect(a).toBe(extensionFileCacheKey("https://a.example", "acme.theme", release, "storefront.js"));
  });

  it("keeps a store's origin one path segment", () => {
    const key = extensionFileCacheKey("https://a.example:8443", "p", "r", "x.js");
    expect(key.split("/__storefront-extension/")[1]!.split("/")[0]).toBe(encodeURIComponent("https://a.example:8443"));
  });
});
