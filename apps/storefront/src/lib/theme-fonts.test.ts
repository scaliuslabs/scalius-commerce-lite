import { describe, expect, it } from "vitest";
import { STOREFRONT_FONTS, STOREFRONT_TYPE_PAIRINGS, storefrontPairingFonts } from "@scalius/shared/storefront-theme";
import { themeFontAssets } from "./theme-fonts";

describe("theme fonts", () => {
  it("self-hosts Inter with a metric-matched fallback and preloads only its Latin face", () => {
    const { css, preload } = themeFontAssets("retail");
    expect(css).toContain('font-family:"Inter"');
    expect(css).toContain("font-display:swap");
    expect(css).toContain('font-family:"Inter Fallback";src:local("Arial");size-adjust:107.30%');
    expect(preload).toHaveLength(1);
    expect(preload[0]).toMatch(/inter-latin-wght-normal/);
  });

  it("serves Bangla from Noto Sans Bengali without pulling it in for the Taka sign", () => {
    const { css } = themeFontAssets("retail");
    const bengali = css.split("@font-face").find((rule) => rule.includes('"Noto Sans Bengali"'))!;
    expect(bengali).toContain("unicode-range:");
    expect(bengali).toContain("U+0980-09F2,U+09F4-09FE");
    expect(bengali).not.toMatch(/U\+0980-09FE/);
  });

  it("builds CSS from constants for every pairing, preloads exactly the heading face, and matches every fallback", () => {
    for (const pairing of STOREFRONT_TYPE_PAIRINGS) {
      const { css, preload } = themeFontAssets(pairing);
      const { fonts, heading } = storefrontPairingFonts(pairing);
      expect(css).not.toMatch(/<|>|\\\\/);
      expect(preload).toHaveLength(1);
      expect(preload[0]).toContain(heading);
      for (const font of fonts) {
        // Each family swaps over a metric-matched local face (no layout shift).
        expect(css).toContain(`font-family:"${STOREFRONT_FONTS[font].family} Fallback";src:local(`);
        expect(css).toMatch(new RegExp(`font-family:"${STOREFRONT_FONTS[font].family}";[^}]*font-display:swap`));
      }
    }
  });
});
