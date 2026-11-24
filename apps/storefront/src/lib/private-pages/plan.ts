/**
 * What a private page draws from the request's theme (published, or the
 * draft in a preview): its arrangement as this build reads it, its frame,
 * the host's token rules compiled on save, labels and icons. Everything comes
 * from the theme document the request already read, so a custom arrangement
 * costs no query. A theme writes no markup and no CSS here.
 */
import {
  PRIVATE_PAGES,
  PRIVATE_TOKEN_MODE_CSS,
  privateFrame,
  privatePagesCss,
  privateItemIsDefault,
  privatePageTokenMode,
  servedPrivatePages,
  privateLayoutIsDefault,
  privatePageArrangement,
  privatePageLabels,
  type PrivateNode,
  type PrivatePageKey,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { PrivateAssetUrl } from "./html";
import { privateLabelVariantWords } from "./labels";

export interface PrivatePagePlan {
  page: PrivatePageKey;
  /** The frame's variant (the page's default when the theme names none). */
  frame: string | undefined;
  /** The page's layout; null draws the host's own page, exactly as without a theme. */
  layout: PrivateNode[] | null;
  /** Each repeated unit's layout; null draws the host's own. */
  items: Record<string, PrivateNode[] | null>;
  /** The theme's labels for this page, in the page's language. */
  labels: Record<string, string>;
  /** The theme's icons for this page, by key, as URLs. */
  icons: Record<string, string>;
  /**
   * The page is in token mode (the theme set tokens): every colour comes from
   * the compiled table, and the page is drawn from its arrangement (the
   * default one when the theme set none), so the table's places are the page's.
   */
  tokens: boolean;
}

export function privatePagePlan(theme: StorefrontThemeDocument, page: PrivatePageKey, language: string, asset: PrivateAssetUrl): PrivatePagePlan {
  const privatePages = servedPrivatePages(theme.privatePages);
  const arrangement = privatePageArrangement(privatePages, page);
  const spec = PRIVATE_PAGES[page];
  const tokens = privatePageTokenMode(theme.privatePages, page);
  const icons = Object.fromEntries(spec.icons.flatMap((key) => {
    const ref = privatePages.icons[key];
    const url = ref ? asset(ref) : null;
    return url ? [[key, url]] : [];
  }));
  return {
    page,
    frame: privateFrame(page, arrangement),
    layout: tokens ? [...arrangement?.layout ?? spec.layout] : privateLayoutIsDefault(page, arrangement) ? null : arrangement!.layout!,
    items: Object.fromEntries(Object.keys(spec.items).map((item) => [item, privateItemIsDefault(page, item, arrangement) ? null : arrangement!.items![item]!])),
    labels: privatePageLabels(privatePages, page, language, (variant) => privateLabelVariantWords(variant, language)),
    icons,
    tokens,
  };
}

/**
 * The theme's look as the page writes it ("" for none): in token mode, the
 * host's palette classes around the compiled colour table (surfaces before
 * it, every other colour after it: private-tokens.ts `PRIVATE_TOKEN_MODE_CSS`),
 * then the compiled table and token rules: host CSS written from typed
 * values on save. Only what this build's checker compiled is served
 * (`privatePagesCss`).
 */
export function privateStyle(theme: StorefrontThemeDocument, page: PrivatePageKey = "cart"): string {
  const css = privatePagesCss(theme.privatePages);
  if (!css) return "";
  const tokens = privatePageTokenMode(theme.privatePages, page);
  return `${tokens ? PRIVATE_TOKEN_MODE_CSS.before : ""}${css}${tokens ? PRIVATE_TOKEN_MODE_CSS.after : ""}`;
}
