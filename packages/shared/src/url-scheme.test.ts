import { describe, expect, it } from "vitest";
import { isValidUrlScheme } from "@scalius/shared/url-scheme";

describe("isValidUrlScheme", () => {
  it("returns true for http: URLs", () => {
    expect(isValidUrlScheme("http://example.com")).toBe(true);
    expect(isValidUrlScheme("http://wa.me/8801712345678")).toBe(true);
  });

  it("returns true for https: URLs", () => {
    expect(isValidUrlScheme("https://example.com")).toBe(true);
    expect(isValidUrlScheme("https://wa.me/8801712345678")).toBe(true);
    expect(isValidUrlScheme("https://facebook.com/store")).toBe(true);
  });

  it("returns false for javascript: URLs (XSS prevention)", () => {
    expect(isValidUrlScheme("javascript:alert(1)")).toBe(false);
    expect(isValidUrlScheme("javascript:void(0)")).toBe(false);
    expect(isValidUrlScheme("JAVASCRIPT:alert(1)")).toBe(false);
  });

  it("returns false for data: URLs (XSS prevention)", () => {
    expect(isValidUrlScheme("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isValidUrlScheme("data:text/plain,hello")).toBe(false);
  });

  it("returns false for vbscript: URLs", () => {
    expect(isValidUrlScheme("vbscript:msgbox(1)")).toBe(false);
  });

  it("returns false for invalid/unparseable URLs", () => {
    expect(isValidUrlScheme("not-a-url")).toBe(false);
    expect(isValidUrlScheme("")).toBe(false);
    expect(isValidUrlScheme("   ")).toBe(false);
  });

  it("returns false for URLs with no protocol", () => {
    expect(isValidUrlScheme("example.com")).toBe(false);
    expect(isValidUrlScheme("//example.com")).toBe(false);
    expect(isValidUrlScheme("/path/to/page")).toBe(false);
  });

  it("returns false for ftp: and other non-http schemes", () => {
    expect(isValidUrlScheme("ftp://example.com")).toBe(false);
    expect(isValidUrlScheme("mailto:test@example.com")).toBe(false);
    expect(isValidUrlScheme("tel:+8801712345678")).toBe(false);
  });
});
