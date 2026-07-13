import { describe, expect, it } from "vitest";

import {
  getThemeColorError,
  getThemeColorPairStatus,
} from "./theme-color-accessibility";

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
});
