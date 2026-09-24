// Self-hosted web fonts for the theme's type pairing (Theme -> Style).
//
// Each family is served from the storefront's own assets (no third-party
// font CDN): woff2 variable files, `font-display: swap`, and a metric-matched
// fallback face (size-adjust + ascent/descent overrides on a local system
// font) so swapping in the web font does not shift layout. Latin faces carry
// a Latin unicode-range, so Bangla text falls through to the Bengali family
// that follows in the stack. Only the heading's Latin file is preloaded.
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import interLatinExt from "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url";
import instrumentSerifLatin from "@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2?url";
import dmSerifDisplayLatin from "@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff2?url";
import dmSansLatin from "@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2?url";
import nunitoSansLatin from "@fontsource-variable/nunito-sans/files/nunito-sans-latin-wght-normal.woff2?url";
import cormorantLatin from "@fontsource-variable/cormorant-garamond/files/cormorant-garamond-latin-wght-normal.woff2?url";
import notoSansBengali from "@fontsource-variable/noto-sans-bengali/files/noto-sans-bengali-bengali-wght-normal.woff2?url";
import notoSerifBengali from "@fontsource-variable/noto-serif-bengali/files/noto-serif-bengali-bengali-wght-normal.woff2?url";
import hindSiliguri400 from "@fontsource/hind-siliguri/files/hind-siliguri-bengali-400-normal.woff2?url";
import hindSiliguri700 from "@fontsource/hind-siliguri/files/hind-siliguri-bengali-700-normal.woff2?url";
import {
  STOREFRONT_BANGLA_FONTS,
  STOREFRONT_FONTS,
  storefrontPairingFonts,
  type StorefrontFontKey,
  type StorefrontTypePairing,
} from "@scalius/shared/storefront-theme";

interface FontFile {
  url: string;
  unicodeRange: string;
  /** For static files: the weight range this file serves (defaults to the family's). */
  weights?: string;
  /** The subset buyers see first (preloaded when it is the heading face). */
  primary?: boolean;
}

interface FallbackMetrics {
  local: string;
  sizeAdjust: string;
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
}

const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT_RANGE =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
/**
 * Bengali script without the Taka sign (U+09F3): prices ("৳2,500") appear on
 * nearly every page, and they should not download a 100 KB Bengali face on
 * English pages; the sign renders from the system font as before.
 */
const BENGALI_RANGE =
  "U+0951-0952,U+0964-0965,U+0980-09F2,U+09F4-09FE,U+1CD0,U+1CD2,U+1CD5-1CD6,U+1CD8,U+1CE1,U+1CEA,U+1CED,U+1CF2,U+1CF5-1CF7,U+200C-200D,U+25CC,U+A8F1";

/**
 * Only the Latin (and Inter's Latin Extended) subsets ship: store copy is
 * English or Bangla, and Bangla comes from the Bengali family.
 */
const FONT_FILES: Record<StorefrontFontKey, { weights: string; files: FontFile[] }> = {
  inter: {
    weights: "100 900",
    files: [
      { url: interLatin, unicodeRange: LATIN_RANGE, primary: true },
      { url: interLatinExt, unicodeRange: LATIN_EXT_RANGE },
    ],
  },
  "instrument-serif": { weights: "400", files: [{ url: instrumentSerifLatin, unicodeRange: LATIN_RANGE, primary: true }] },
  "dm-serif-display": { weights: "400", files: [{ url: dmSerifDisplayLatin, unicodeRange: LATIN_RANGE, primary: true }] },
  "dm-sans": { weights: "100 1000", files: [{ url: dmSansLatin, unicodeRange: LATIN_RANGE, primary: true }] },
  "nunito-sans": { weights: "200 1000", files: [{ url: nunitoSansLatin, unicodeRange: LATIN_RANGE, primary: true }] },
  "cormorant-garamond": { weights: "300 700", files: [{ url: cormorantLatin, unicodeRange: LATIN_RANGE, primary: true }] },
};

const BANGLA_FILES: Record<keyof typeof STOREFRONT_BANGLA_FONTS, { weights: string; files: FontFile[] }> = {
  sans: { weights: "100 900", files: [{ url: notoSansBengali, unicodeRange: BENGALI_RANGE }] },
  serif: { weights: "100 900", files: [{ url: notoSerifBengali, unicodeRange: BENGALI_RANGE }] },
  // Static cuts: regular for text, bold for headings.
  hind: {
    weights: "300 700",
    files: [
      { url: hindSiliguri400, unicodeRange: BENGALI_RANGE, weights: "300 500" },
      { url: hindSiliguri700, unicodeRange: BENGALI_RANGE, weights: "600 900" },
    ],
  },
};

/**
 * Metric overrides that make a local font occupy the web font's box, so the
 * swap never shifts text. Computed from the shipped woff2 files and the local
 * fallback (capsize/Next.js method: size-adjust from the frequency-weighted
 * average advance width; ascent/descent/line-gap from hhea over size-adjust).
 */
const FALLBACK_METRICS: Record<StorefrontFontKey, FallbackMetrics> = {
  inter: { local: "Arial", sizeAdjust: "107.30%", ascentOverride: "90.28%", descentOverride: "22.48%", lineGapOverride: "0%" },
  "instrument-serif": { local: "Georgia", sizeAdjust: "76.78%", ascentOverride: "128.94%", descentOverride: "40.38%", lineGapOverride: "0%" },
  "dm-serif-display": { local: "Georgia", sizeAdjust: "101.02%", ascentOverride: "102.55%", descentOverride: "33.16%", lineGapOverride: "0%" },
  "dm-sans": { local: "Arial", sizeAdjust: "105.54%", ascentOverride: "94.00%", descentOverride: "29.37%", lineGapOverride: "0%" },
  "nunito-sans": { local: "Arial", sizeAdjust: "98.02%", ascentOverride: "103.15%", descentOverride: "36.01%", lineGapOverride: "0%" },
  "cormorant-garamond": { local: "Georgia", sizeAdjust: "88.33%", ascentOverride: "104.60%", descentOverride: "32.49%", lineGapOverride: "0%" },
};

function fontFace(family: string, weights: string, file: FontFile): string {
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${file.weights ?? weights};font-display:swap;src:url("${file.url}") format("woff2");unicode-range:${file.unicodeRange};}`;
}

function fallbackFace(family: string, metrics: FallbackMetrics): string {
  return `@font-face{font-family:"${family} Fallback";src:local("${metrics.local}");size-adjust:${metrics.sizeAdjust};ascent-override:${metrics.ascentOverride};descent-override:${metrics.descentOverride};line-gap-override:${metrics.lineGapOverride};}`;
}

export interface ThemeFontAssets {
  /** `@font-face` rules for the pairing's installed families. */
  css: string;
  /** Font files to preload (the heading's Latin face). */
  preload: string[];
}

const cache = new Map<StorefrontTypePairing, ThemeFontAssets>();

/** The @font-face CSS and preloads a type pairing needs. Values are constants. */
export function themeFontAssets(pairing: StorefrontTypePairing): ThemeFontAssets {
  const cached = cache.get(pairing);
  if (cached) return cached;
  const { fonts, bangla, heading } = storefrontPairingFonts(pairing);
  const rules: string[] = [];
  const preload: string[] = [];
  for (const key of fonts) {
    const installed = FONT_FILES[key];
    const family = STOREFRONT_FONTS[key].family;
    for (const file of installed.files) rules.push(fontFace(family, installed.weights, file));
    rules.push(fallbackFace(family, FALLBACK_METRICS[key]));
    if (key === heading) {
      const primary = installed.files.find((file) => file.primary);
      if (primary) preload.push(primary.url);
    }
  }
  const bengali = BANGLA_FILES[bangla];
  for (const file of bengali.files) rules.push(fontFace(STOREFRONT_BANGLA_FONTS[bangla].family, bengali.weights, file));
  const assets = { css: rules.join(""), preload };
  cache.set(pairing, assets);
  return assets;
}
