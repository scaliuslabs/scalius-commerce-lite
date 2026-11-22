/**
 * What a private page draws from the request's theme (published, or the
 * draft in a preview): its arrangement as this build reads it, its frame,
 * the theme's compiled stylesheet, labels and icons. Everything comes from
 * the theme document the request already read, so a custom arrangement costs
 * no query; the stylesheet was checked and scoped when the theme was saved.
 */
import {
  PRIVATE_PAGES,
  privateFrame,
  privateGuardSelectors,
  privateItemIsDefault,
  privateLayoutIsDefault,
  privatePageArrangement,
  privatePageLabels,
  type PrivateNode,
  type PrivatePageKey,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { PrivateAssetUrl } from "./html";

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
}

export function privatePagePlan(theme: StorefrontThemeDocument, page: PrivatePageKey, language: string, asset: PrivateAssetUrl): PrivatePagePlan {
  const arrangement = privatePageArrangement(theme.privatePages, page);
  const spec = PRIVATE_PAGES[page];
  const icons = Object.fromEntries(spec.icons.flatMap((key) => {
    const ref = theme.privatePages.icons[key];
    const url = ref ? asset(ref) : null;
    return url ? [[key, url]] : [];
  }));
  return {
    page,
    frame: privateFrame(page, arrangement),
    layout: privateLayoutIsDefault(page, arrangement) ? null : arrangement!.layout!,
    items: Object.fromEntries(Object.keys(spec.items).map((item) => [item, privateItemIsDefault(page, item, arrangement) ? null : arrangement!.items![item]!])),
    labels: privatePageLabels(theme.privatePages, page, language),
    icons,
  };
}

/** The theme's private stylesheet as the page writes it ("" for none), and what its guard checks. */
export function privateStyle(theme: StorefrontThemeDocument, pages: readonly PrivatePageKey[]): { css: string; guard: string } {
  const css = theme.privatePages.compiled.css;
  return { css, guard: css ? JSON.stringify(pages.flatMap((page) => privateGuardSelectors(page))) : "" };
}
