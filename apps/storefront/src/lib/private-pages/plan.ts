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
  privateCheckoutBlockArrangement,
  type PrivateNode,
  type PrivatePageKey,
  type PrivateUnitSpec,
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
  /**
   * The variant each part with variants draws: the one the layout names, else
   * its default. A unit's parts carry theirs in its template's marks instead.
   */
  variants: Record<string, string>;
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
  const spec = PRIVATE_PAGES[page];
  const tokens = privatePageTokenMode(theme.privatePages, page);
  // In token mode a page with no arrangement draws the one its look was checked on (the payment step's from its block).
  const arrangement = privatePageArrangement(privatePages, page) ?? (tokens && page === "checkout" ? privateCheckoutBlockArrangement(theme.blocks.checkout) : undefined);
  const layout = tokens ? [...arrangement?.layout ?? spec.layout] : privateLayoutIsDefault(page, arrangement) ? null : arrangement!.layout!;
  const icons = Object.fromEntries(spec.icons.flatMap((key) => {
    const ref = privatePages.icons[key];
    const url = ref ? asset(ref) : null;
    return url ? [[key, url]] : [];
  }));
  return {
    page,
    frame: privateFrame(page, arrangement),
    layout,
    items: Object.fromEntries(Object.keys(spec.items).map((item) => [item, privateItemIsDefault(page, item, arrangement) ? null : arrangement!.items![item]!])),
    variants: partVariants(spec.parts, layout ?? []),
    labels: privatePageLabels(privatePages, page, language, (variant) => privateLabelVariantWords(variant, language)),
    icons,
    tokens,
  };
}

function partVariants(parts: PrivateUnitSpec["parts"], layout: readonly PrivateNode[]): Record<string, string> {
  const named: Record<string, string> = {};
  const walk = (nodes: readonly PrivateNode[]) => {
    for (const node of nodes) {
      if (node.type === "part" && node.variant !== undefined) named[node.part] = node.variant;
      else if (node.type === "layout") walk(node.children);
    }
  };
  walk(layout);
  return Object.fromEntries(Object.entries(parts).flatMap(([name, spec]) => spec.variants ? [[name, named[name] ?? spec.variants[0]]] : []));
}

/**
 * The theme's look as the page writes it ("" for none): in token mode, the
 * host's palette classes around the compiled colour table (surfaces before
 * it, every other colour after it: private-tokens.ts `PRIVATE_TOKEN_MODE_CSS`),
 * then the compiled table and token rules: host CSS written from typed
 * values on save. Only what this build's checker compiled is served
 * (`privatePagesCss`).
 */
export function privateStyle(theme: StorefrontThemeDocument, page: PrivatePageKey): string {
  const css = privatePagesCss(theme.privatePages, page);
  if (!css) return "";
  const tokens = privatePageTokenMode(theme.privatePages, page);
  return `${tokens ? PRIVATE_TOKEN_MODE_CSS.before : ""}${css}${tokens ? PRIVATE_TOKEN_MODE_CSS.after : ""}`;
}
