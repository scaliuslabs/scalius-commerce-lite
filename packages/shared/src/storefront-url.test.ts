import { describe, expect, it } from "vitest";

import {
  buildStorefrontPath,
  normalizeStorefrontOrigin,
} from "./storefront-url";

describe("normalizeStorefrontOrigin", () => {
  it.each([
    ["https://shop.example.com", "https://shop.example.com"],
    [" https://shop.example.com/ ", "https://shop.example.com"],
    ["https://shop.example.com:8443", "https://shop.example.com:8443"],
    ["http://localhost:4321", "http://localhost:4321"],
    ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
    ["http://[::1]:8787", "http://[::1]:8787"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeStorefrontOrigin(input)).toBe(expected);
  });

  it.each([
    "",
    "/",
    "shop.example.com",
    "http://shop.example.com",
    "ftp://shop.example.com",
    "https://user:secret@shop.example.com",
    "https://shop.example.com/store",
    "https://shop.example.com/?preview=1",
    "https://shop.example.com/#home",
  ])("rejects non-origin input %s", (input) => {
    expect(normalizeStorefrontOrigin(input)).toBeNull();
  });
});

describe("buildStorefrontPath", () => {
  it("retains the explicit legacy relative fallback for non-discovery callers", () => {
    expect(buildStorefrontPath("products/example", "/")).toBe(
      "/products/example",
    );
  });
});
