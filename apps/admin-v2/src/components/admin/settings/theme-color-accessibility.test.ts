import { describe, expect, it } from "vitest";

import {
  getThemeColorError,
  getThemeColorPairStatus,
} from "./theme-color-accessibility";
import {
  DEFAULT_THEME_COLORS,
  THEME_COLOR_PALETTES,
  THEME_CONTRAST_PAIRS,
} from "./theme-color-presets";

describe("theme color accessibility", () => {
  it("reports readable and unreadable opaque hex pairs", () => {
    expect(getThemeColorPairStatus("#ffffff", "#18181b")).toEqual({
      ratio: 17.7,
      passes: true,
    });
    expect(getThemeColorPairStatus("#ffffff", "#e4e4e7")).toEqual({
      ratio: 1.3,
      passes: false,
    });
  });

  it("supports shorthand hex and leaves functional colors unscored", () => {
    expect(getThemeColorPairStatus("#fff", "#000")).toEqual({
      ratio: 21,
      passes: true,
    });
    expect(getThemeColorPairStatus("oklch(1 0 0)", "#000000")).toEqual({
      ratio: null,
      passes: null,
    });
  });

  it("uses the storefront sanitizer contract for field validation", () => {
    expect(getThemeColorError("#2563eb")).toBeNull();
    expect(getThemeColorError("oklch(0.5 0.2 250)")).toBeNull();
    expect(getThemeColorError("url(javascript:alert(1))")).toBe(
      "Use a supported CSS color value.",
    );
  });

  it("keeps every essential pair in every preset at or above 4.5:1", () => {
    for (const [paletteName, palette] of Object.entries(THEME_COLOR_PALETTES)) {
      for (const { background, foreground } of THEME_CONTRAST_PAIRS) {
        const status = getThemeColorPairStatus(
          palette.colors[foreground] ?? "",
          palette.colors[background] ?? "",
        );

        expect(
          status.ratio,
          `${paletteName}: ${foreground} on ${background} should be scored`,
        ).not.toBeNull();
        expect(
          status.passes,
          `${paletteName}: ${foreground} on ${background} is ${status.ratio}:1`,
        ).toBe(true);
      }
    }
  });

  it("uses the verified Zinc palette as the effective default", () => {
    expect(DEFAULT_THEME_COLORS).toBe(THEME_COLOR_PALETTES.Zinc?.colors);
    expect(
      getThemeColorPairStatus(
        DEFAULT_THEME_COLORS["muted-foreground"] ?? "",
        DEFAULT_THEME_COLORS.muted ?? "",
      ),
    ).toEqual({ ratio: 7, passes: true });
  });
});
