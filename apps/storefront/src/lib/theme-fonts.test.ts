import { describe, expect, it } from "vitest";
import { STOREFRONT_BENGALI_SYSTEM_FONT, STOREFRONT_FONTS, STOREFRONT_TYPE_PAIRINGS, storefrontPairingFonts } from "@scalius/shared/storefront-theme";
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

  it("names the system Bengali font so the Taka sign never takes the platform font search", () => {
    for (const pairing of STOREFRONT_TYPE_PAIRINGS) {
      const { css } = themeFontAssets(pairing);
      const faces = css.split("@font-face").filter((rule) => rule.includes(`"${STOREFRONT_BENGALI_SYSTEM_FONT}"`));
      expect(faces).toHaveLength(2);
      for (const face of faces) {
        // Local files only (no download), over the whole Bengali block including U+09F3.
        expect(face).not.toContain("url(");
        expect(face).toContain("unicode-range:U+0980-09FF");
        expect(face).toMatch(/src:local\("[^"]+"\)(,local\("[^"]+"\))*;/);
      }
      expect(faces[0]).toContain("font-weight:100 500");
      expect(faces[1]).toContain("font-weight:600 900");
      // A bold cut first, then the regular cuts, so bold text always finds a face.
      expect(faces[1].indexOf('local("Nirmala UI Bold")')).toBeLessThan(faces[1].indexOf('local("Nirmala UI")'));
    }
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
