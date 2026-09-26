import {
  STOREFRONT_TEMPLATE_IDS,
  resolveStorefrontTheme,
  storefrontTemplateTheme,
  type StoreShape,
} from "@scalius/shared/storefront-theme";
import type { Product } from "@/lib/api";
import { renderedContentBlocks } from "./product-page-modules";
import type { RequestTheme } from "@/lib/storefront-theme-context";

/** A product overrides its product blocks only; the store's shell and tokens stay intact. */
export function resolveProductPageTheme(
  requestTheme: Pick<RequestTheme, "theme" | "resolved">,
  product: Pick<Product, "pageTemplate" | "contentBlocks">,
  shape: StoreShape,
) {
  const id = product.pageTemplate === "classic" ? "department-mall" : product.pageTemplate;
  const template = STOREFRONT_TEMPLATE_IDS.find((candidate) => candidate === id);
  // The layout aggregate may not know about this product's content yet.
  const hasContentBlocks = renderedContentBlocks(product).length > 0;
  if (!template && hasContentBlocks === shape.hasContentBlocks) return requestTheme.resolved;
  return resolveStorefrontTheme({
    ...requestTheme.theme,
    blocks: { ...requestTheme.theme.blocks, product: template ? storefrontTemplateTheme(template).blocks.product : requestTheme.theme.blocks.product },
  }, { ...shape, hasContentBlocks });
}
