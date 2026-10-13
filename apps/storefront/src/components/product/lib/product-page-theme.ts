import {
  STOREFRONT_TEMPLATE_IDS,
  resolveStorefrontTheme,
  storefrontTemplateTheme,
  type StoreShape,
} from "@scalius/shared/storefront-theme";
import type { Product } from "@/lib/api";
import type { RequestTheme } from "@/lib/storefront-theme-context";

/**
 * A product's own page template (`pageTemplate`) swaps in that template's
 * product blocks (gallery, buy box, modules, sticky bars) as data; the
 * store's shell and tokens stay intact. Without one, the request theme is
 * used as is: the store shape already says whether any public product has
 * content blocks (`hasContentBlocks`), and the page leaves out a module this
 * product has nothing for.
 */
export function resolveProductPageTheme(
  requestTheme: Pick<RequestTheme, "theme" | "resolved">,
  product: Pick<Product, "pageTemplate">,
  shape: StoreShape,
) {
  const named = product.pageTemplate ?? null;
  const id = named === "classic" ? "department-mall" : named;
  const template = STOREFRONT_TEMPLATE_IDS.find((candidate) => candidate === id);
  if (!template) return requestTheme.resolved;
  return resolveStorefrontTheme({
    ...requestTheme.theme,
    blocks: { ...requestTheme.theme.blocks, product: storefrontTemplateTheme(template).blocks.product },
  }, shape);
}
