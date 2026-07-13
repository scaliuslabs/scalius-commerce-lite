import { describe, expect, it } from "vitest";

import { DEFAULT_STOREFRONT_THEME_SETTINGS } from "@scalius/shared/storefront-theme";
import { resolveStorefrontThemeSettings } from "./storefront.service";

describe("storefront theme projection", () => {
  it("prefers the versioned document and sanitizes its tokens", () => {
    expect(resolveStorefrontThemeSettings(
      JSON.stringify({
        colors: { primary: " #2563eb ", unsafe: "url(evil)" },
        typography: { heading: "editorial", body: "system", scale: "standard" },
        cornerStyle: "rounded",
        density: "comfortable",
        containerWidth: "wide",
        components: { buttons: "solid", inputs: "outlined", cards: "bordered" },
      }),
      JSON.stringify({ primary: "#be123c" }),
    )).toEqual({
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#2563eb" },
      typography: { heading: "editorial", body: "system", scale: "standard" },
      cornerStyle: "rounded",
    });
  });

  it("uses the legacy row only when no versioned document exists", () => {
    expect(resolveStorefrontThemeSettings(
      undefined,
      JSON.stringify({ primary: "#047857" }),
    )).toEqual({
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#047857" },
    });
    expect(resolveStorefrontThemeSettings("{}", JSON.stringify({ primary: "#047857" })))
      .toEqual(DEFAULT_STOREFRONT_THEME_SETTINGS);
  });
});
