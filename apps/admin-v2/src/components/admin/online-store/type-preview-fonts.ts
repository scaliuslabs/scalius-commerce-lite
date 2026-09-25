// The storefront's self-hosted type pairing files, for the Theme page's
// Typography picker. Imported only when the picker opens (dynamic import), so
// the Theme page's first render never carries the font URLs or downloads a
// face. The files are the storefront's own (apps/storefront/src/lib/
// theme-fonts.ts, same packages and subsets); faces register under
// `Preview <Family>` names so they never shadow the dashboard's Inter or
// Noto Sans Bengali, and the browser fetches each file only when a preview
// line uses it.
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
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
  type StorefrontFontKey,
} from "@scalius/shared/storefront-theme";
import { previewFamily } from "./theme-settings";

interface PreviewFile {
  url: string;
  weights: string;
  unicodeRange: string;
}

const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const BENGALI_RANGE =
  "U+0951-0952,U+0964-0965,U+0980-09F2,U+09F4-09FE,U+1CD0,U+1CD2,U+1CD5-1CD6,U+1CD8,U+1CE1,U+1CEA,U+1CED,U+1CF2,U+1CF5-1CF7,U+200C-200D,U+25CC,U+A8F1";

/** Keyed by the contract's font keys, so a new family fails the type check until it has a file here. */
const LATIN_FILES: Record<StorefrontFontKey, PreviewFile[]> = {
  inter: [{ url: interLatin, weights: "100 900", unicodeRange: LATIN_RANGE }],
  "instrument-serif": [{ url: instrumentSerifLatin, weights: "400", unicodeRange: LATIN_RANGE }],
  "dm-serif-display": [{ url: dmSerifDisplayLatin, weights: "400", unicodeRange: LATIN_RANGE }],
  "dm-sans": [{ url: dmSansLatin, weights: "100 1000", unicodeRange: LATIN_RANGE }],
  "nunito-sans": [{ url: nunitoSansLatin, weights: "200 1000", unicodeRange: LATIN_RANGE }],
  "cormorant-garamond": [{ url: cormorantLatin, weights: "300 700", unicodeRange: LATIN_RANGE }],
};

const BANGLA_FILES: Record<keyof typeof STOREFRONT_BANGLA_FONTS, PreviewFile[]> = {
  sans: [{ url: notoSansBengali, weights: "100 900", unicodeRange: BENGALI_RANGE }],
  serif: [{ url: notoSerifBengali, weights: "100 900", unicodeRange: BENGALI_RANGE }],
  hind: [
    { url: hindSiliguri400, weights: "300 500", unicodeRange: BENGALI_RANGE },
    { url: hindSiliguri700, weights: "600 900", unicodeRange: BENGALI_RANGE },
  ],
};

let registered = false;

/** Registers every pairing's faces once; the browser downloads a file when a preview first draws with it. */
export function registerTypePreviewFonts(): void {
  if (registered || typeof document === "undefined" || !("fonts" in document) || typeof FontFace === "undefined") return;
  registered = true;
  const add = (family: string, file: PreviewFile) => {
    document.fonts.add(new FontFace(previewFamily(family), `url("${file.url}") format("woff2")`, {
      weight: file.weights,
      unicodeRange: file.unicodeRange,
      display: "swap",
    }));
  };
  for (const [key, files] of Object.entries(LATIN_FILES) as Array<[StorefrontFontKey, PreviewFile[]]>) {
    for (const file of files) add(STOREFRONT_FONTS[key].family, file);
  }
  for (const [key, files] of Object.entries(BANGLA_FILES) as Array<[keyof typeof STOREFRONT_BANGLA_FONTS, PreviewFile[]]>) {
    for (const file of files) add(STOREFRONT_BANGLA_FONTS[key].family, file);
  }
}
