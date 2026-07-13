import { describe, expect, it } from "vitest";

import {
  buildStorefrontThemeTokens,
  DEFAULT_STOREFRONT_THEME_SETTINGS,
  isSafeStorefrontThemeColorValue,
  isStorefrontThemeColorKey,
  listInvalidStorefrontThemeColorEntries,
  listInvalidStorefrontThemeSettingsEntries,
  parseStorefrontThemeSettings,
  sanitizeStorefrontThemeColors,
  sanitizeStorefrontThemeSettings,
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

describe("storefront semantic theme settings", () => {
  it("upgrades a legacy flat color document onto visually stable defaults", () => {
    expect(
      sanitizeStorefrontThemeSettings({
        primary: " #2563eb ",
        unsafe: "url(evil)",
      }),
    ).toEqual({
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#2563eb" },
    });
  });

  it("keeps only the bounded semantic vocabulary", () => {
    expect(
      sanitizeStorefrontThemeSettings({
        colors: { primary: "#047857" },
        typography: {
          heading: "editorial",
          body: "humanist",
          scale: "generous",
        },
        cornerStyle: "rounded",
        density: "compact",
        containerWidth: "focused",
        components: {
          buttons: "soft",
          inputs: "filled",
          cards: "flat",
        },
      }),
    ).toEqual({
      colors: { primary: "#047857" },
      typography: {
        heading: "editorial",
        body: "humanist",
        scale: "generous",
      },
      cornerStyle: "rounded",
      density: "compact",
      containerWidth: "focused",
      components: {
        buttons: "soft",
        inputs: "filled",
        cards: "flat",
      },
    });

    expect(
      listInvalidStorefrontThemeSettingsEntries({
        colors: { primary: "url(evil)" },
        typography: { heading: "remote-font", body: "system", scale: "standard" },
        cornerStyle: "999px",
        density: "comfortable",
        containerWidth: "wide",
        components: { buttons: "script", inputs: "outlined", cards: "bordered" },
        arbitraryCss: "body{display:none}",
      }),
    ).toEqual([
      "arbitraryCss",
      "colors.primary",
      "typography.heading",
      "cornerStyle",
      "components.buttons",
    ]);
  });

  it("generates deterministic CSS tokens without accepting merchant CSS", () => {
    const tokens = buildStorefrontThemeTokens({
      colors: { primary: "#047857", border: "var(--primary)" },
      typography: { heading: "editorial", body: "humanist", scale: "compact" },
      cornerStyle: "square",
      density: "airy",
      containerWidth: "standard",
      components: { buttons: "outline", inputs: "filled", cards: "elevated" },
    });

    expect(tokens).toMatchObject({
      primary: "#047857",
      border: "var(--primary)",
      "theme-font-heading": 'Georgia, "Times New Roman", ui-serif, serif',
      "theme-font-body": 'Optima, Candara, "Noto Sans", ui-sans-serif, sans-serif',
      "theme-type-scale": "0.95",
      radius: "0rem",
      "theme-density-scale": "1.12",
      "theme-container-width": "72rem",
    });
    expect(Object.values(tokens).join(" ")).not.toContain("url(");
  });

  it("fails closed to defaults for malformed stored JSON", () => {
    expect(parseStorefrontThemeSettings("{not json")).toEqual(
      DEFAULT_STOREFRONT_THEME_SETTINGS,
    );
  });
});
