/**
 * What a private page draws from the request's theme (published, or the
 * draft in a preview): its arrangement as this build reads it, its frame,
 * the theme's compiled stylesheet, labels and icons. Everything comes from
 * the theme document the request already read, so a custom arrangement costs
 * no query; the stylesheet was checked and scoped when the theme was saved.
 */
import {
  PRIVATE_PAGES,
  privateAssetProperty,
  privateFrame,
  privatePagesCss,
  privateProtectedSelectors,
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

/** A store-origin path to a theme file, as the page may write it inside `url("…")`. */
const ASSET_PATH = /^\/_x\/[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._-]+\/public\/[A-Za-z0-9._%/-]+$/;

/**
 * The theme's private stylesheet as the page writes it ("" for none) and what
 * its guard checks. Only CSS this build's checker approved is served
 * (`privatePagesCss`). The theme's assets become the custom properties its
 * stylesheet names (`url(<asset>)` was compiled to `var(--private-asset-…)`),
 * each URL built here from the store's own origin; an asset whose app is not
 * active draws nothing.
 */
export function privateStyle(theme: StorefrontThemeDocument, pages: readonly PrivatePageKey[], asset: PrivateAssetUrl): { css: string; guard: string } {
  const css = privatePagesCss(theme.privatePages);
  if (!css) return { css: "", guard: "" };
  const properties = Object.entries(theme.privatePages.assets).flatMap(([key, ref]) => {
    const url = asset(ref);
    return url && ASSET_PATH.test(url) ? [`${privateAssetProperty(key)}:url("${url}")`] : [];
  });
  return {
    css: `${properties.length > 0 ? `body[data-private-body]{${properties.join(";")}}` : ""}${css}`,
    guard: JSON.stringify(pages.flatMap((page) => privateProtectedSelectors(page))),
  };
}
