/**
 * What a private page draws from the request's theme (published, or the
 * draft in a preview): its arrangement as this build reads it, its frame,
 * the theme's compiled stylesheet, labels and icons. Everything comes from
 * the theme document the request already read, so a custom arrangement costs
 * no query; the stylesheet was checked and scoped when the theme was saved.
 */
import {
  PRIVATE_PAGES,
  PRIVATE_TOKEN_BASE_CSS,
  privateAssetProperty,
  privateFrame,
  privatePagesCss,
  privateItemIsDefault,
  servedPrivatePages,
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
  const privatePages = servedPrivatePages(theme.privatePages);
  const arrangement = privatePageArrangement(privatePages, page);
  const spec = PRIVATE_PAGES[page];
  const icons = Object.fromEntries(spec.icons.flatMap((key) => {
    const ref = privatePages.icons[key];
    const url = ref ? asset(ref) : null;
    return url ? [[key, url]] : [];
  }));
  return {
    page,
    frame: privateFrame(page, arrangement),
    layout: privateLayoutIsDefault(page, arrangement) ? null : arrangement!.layout!,
    items: Object.fromEntries(Object.keys(spec.items).map((item) => [item, privateItemIsDefault(page, item, arrangement) ? null : arrangement!.items![item]!])),
    labels: privatePageLabels(privatePages, page, language),
    icons,
  };
}

/** A store-origin path to a theme file, as the page may write it inside `url("…")`. */
const ASSET_PATH = /^\/_x\/[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._-]+\/public\/[A-Za-z0-9._%/-]+$/;

/**
 * The seal on every free region (private-anatomy.ts `PRIVATE_FREE_REGIONS`):
 * its own containing block and stacking context; its size, layout, paint
 * and style contained, inline size included, so nothing inside widens the
 * page or a grid column (`contain: inline-size`, `min-inline-size: 0`);
 * everything painted inside clipped (with the older browsers' overflow clip
 * first); and a bounded height. The stylesheet never selects a wrapper.
 */
export const PRIVATE_FREE_REGION_SEAL =
  "[data-free]{display:block;position:relative;z-index:0;isolation:isolate;min-inline-size:0;max-inline-size:100%;overflow:hidden;overflow:clip;contain:inline-size layout paint style;max-block-size:30rem}"
  + '[data-free="header"]{max-block-size:24rem}[data-free="footer"]{max-block-size:80rem}';

/**
 * The theme's look as the page writes it ("" for none): the region seal, the
 * token rules' base (host surfaces reset carried text colours), the
 * theme's assets as the custom properties its stylesheet names (each URL
 * built here from the store's own origin; an asset whose app is not active
 * draws nothing), then the compiled token rules and stylesheet. Only what
 * this build's checker compiled is served (`privatePagesCss`).
 */
export function privateStyle(theme: StorefrontThemeDocument, asset: PrivateAssetUrl): string {
  const css = privatePagesCss(theme.privatePages);
  if (!css) return "";
  const properties = Object.entries(theme.privatePages.assets).flatMap(([key, ref]) => {
    const url = asset(ref);
    return url && ASSET_PATH.test(url) ? [`${privateAssetProperty(key)}:url("${url}")`] : [];
  });
  return `${PRIVATE_FREE_REGION_SEAL}${PRIVATE_TOKEN_BASE_CSS}${properties.length > 0 ? `body[data-private-body]{${properties.join(";")}}` : ""}${css}`;
}
