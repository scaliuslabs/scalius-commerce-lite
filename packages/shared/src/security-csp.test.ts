import { describe, expect, it } from "vitest";

import {
  normalizeMerchantCspSource,
  normalizePlatformOrigin,
  parseMerchantCspSources,
  serializeMerchantCspSources,
} from "./security-csp";

describe("security CSP source normalization", () => {
  it("canonicalizes exact and explicit wildcard sources without inventing scope", () => {
    expect(normalizeMerchantCspSource("Pay.Example.com").value).toBe(
      "https://pay.example.com",
    );
    expect(normalizeMerchantCspSource("https://*.Example.com").value).toBe(
      "https://*.example.com",
    );
    expect(
      parseMerchantCspSources(
        "pay.example.com, *.example.com\npay.example.com",
      ),
    ).toEqual(["https://pay.example.com", "https://*.example.com"]);
  });

  it("rejects credentials, paths, unsafe schemes, and broad wildcards", () => {
    for (const source of [
      "https://user:pass@example.com",
      "https://example.com/path",
      "https://example.com?next=1",
      "javascript:alert(1)",
      "data:text/plain,test",
      "*",
      "*.*.example.com",
    ]) {
      expect(normalizeMerchantCspSource(source).value, source).toBeNull();
    }
  });

  it.each([
    ["not a url", "invalid"],
    ["https://not%20a%20url", "invalid"],
    ["chat", "invalid"],
    ["http://chat.example.com", "https"],
    ["chat.example.com/widget", "path"],
    ["https://chat.example.com?x=1", "path"],
    ["*.example.com/path", "path"],
  ] as const)("names what's wrong with %j", (source, problem) => {
    expect(normalizeMerchantCspSource(source)).toEqual({ value: null, error: problem });
  });

  it("permits HTTP only for explicit loopback development origins", () => {
    expect(normalizeMerchantCspSource("http://localhost:3000").value).toBe(
      "http://localhost:3000",
    );
    expect(normalizeMerchantCspSource("http://example.com").value).toBeNull();
  });

  it("serializes a stable compatibility value and validates inherited origins", () => {
    expect(
      serializeMerchantCspSources([
        "HTTPS://PAY.EXAMPLE.COM",
        "pay.example.com",
        "*.widgets.example.com",
      ]),
    ).toBe("https://pay.example.com,https://*.widgets.example.com");
    expect(normalizePlatformOrigin("cdn.example.com")).toBe(
      "https://cdn.example.com",
    );
    expect(
      normalizePlatformOrigin("https://cdn.example.com/assets"),
    ).toBeNull();
    expect(normalizePlatformOrigin("https://*.example.com")).toBeNull();
  });
});
