import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { themeProblemTarget } from "./theme-reveal";

const withColor = (key: "background" | "primary", value: string): StorefrontThemeDocument => ({
  ...DEFAULT_STOREFRONT_THEME,
  tokens: { ...DEFAULT_STOREFRONT_THEME.tokens, colors: { ...DEFAULT_STOREFRONT_THEME.tokens.colors, [key]: value } },
});

describe("themeProblemTarget", () => {
  it("names the colour group and the first invalid colour field", () => {
    expect(themeProblemTarget(withColor("background", "bad-colour"), "tokens")).toEqual({ kind: "group", group: "colors", fieldId: "theme-color-background" });
    expect(themeProblemTarget(withColor("primary", "nope"), "tokens")).toEqual({ kind: "group", group: "colors", fieldId: "theme-color-buttons" });
  });

  it("names the group or the part of the other theme-wide problems", () => {
    expect(themeProblemTarget(DEFAULT_STOREFRONT_THEME, "block:card")).toMatchObject({ kind: "group", group: "productCards" });
    expect(themeProblemTarget(DEFAULT_STOREFRONT_THEME, "block:topBar")).toMatchObject({ kind: "part", part: "announcement" });
    expect(themeProblemTarget(DEFAULT_STOREFRONT_THEME, "homeMode")).toMatchObject({ kind: "part", part: "page", fieldId: "theme-home-product" });
    expect(themeProblemTarget(DEFAULT_STOREFRONT_THEME, "block:footer")).toEqual({ kind: "theme" });
  });

  it("opens the part or group an app's slot settings are in", () => {
    expect(themeProblemTarget(DEFAULT_STOREFRONT_THEME, "app:header")).toMatchObject({ kind: "part", part: "header" });
    expect(themeProblemTarget(DEFAULT_STOREFRONT_THEME, "app:footer")).toMatchObject({ kind: "part", part: "footer" });
    expect(themeProblemTarget(DEFAULT_STOREFRONT_THEME, "app:productCard")).toMatchObject({ kind: "group", group: "productCards" });
  });
});
