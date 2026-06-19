import { describe, expect, it } from "vitest";

import {
  isSafeStorefrontThemeColorValue,
  isStorefrontThemeColorKey,
  listInvalidStorefrontThemeColorEntries,
  sanitizeStorefrontThemeColors,
} from "./storefront-theme";

describe("storefront theme color sanitization", () => {
  it("keeps known theme tokens with safe color values", () => {
    expect(
      sanitizeStorefrontThemeColors({
        primary: " #10b981 ",
        "primary-foreground": "oklch(0.985 0 0)",
        ring: "oklch(0.53 0.14 150 / 0.5)",
        border: "var(--primary)",
        accent: "transparent",
      }),
    ).toEqual({
      primary: "#10b981",
      "primary-foreground": "oklch(0.985 0 0)",
      ring: "oklch(0.53 0.14 150 / 0.5)",
      border: "var(--primary)",
      accent: "transparent",
    });
  });

  it("drops unknown keys, non-string values, and CSS breakout payloads", () => {
    const sanitized = sanitizeStorefrontThemeColors({
      primary: "#059669",
      radius: "999px",
      background: "#fff; color: red",
      foreground: "</style><script>alert(1)</script>",
      card: "url(javascript:alert(1))",
      ring: 42,
    });

    expect(sanitized).toEqual({ primary: "#059669" });
  });

  it("reports invalid entries for API validation", () => {
    expect(
      listInvalidStorefrontThemeColorEntries({
        primary: "#059669",
        unsafe: "#000",
        background: "red; color: blue",
        card: null,
      }),
    ).toEqual(["unsafe", "background", "card"]);
  });

  it("does not treat CSS variable names as open-ended", () => {
    expect(isStorefrontThemeColorKey("primary")).toBe(true);
    expect(isStorefrontThemeColorKey("--primary")).toBe(false);
    expect(isSafeStorefrontThemeColorValue("var(--primary)")).toBe(true);
    expect(isSafeStorefrontThemeColorValue("var(--not-a-theme-token)")).toBe(false);
  });
});
