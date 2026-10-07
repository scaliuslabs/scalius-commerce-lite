// What a product page's app blocks need (the `/storefront/product-apps/<slug>`
// batch part): the published theme's product app blocks, the public product
// they draw for, and the active installations that draw them, in one read
// batch. The API asks each app to draw its block (apps/api
// plugins/storefront-render.ts).

import { productBySlugCondition } from "../catalog";
import { safeBatch, type Database } from "@scalius/database/client";
import { productBuyerState, products, themeSettings, type PluginInstallationRow } from "@scalius/database/schema";
import {
  DEFAULT_STOREFRONT_THEME,
  parseStoredStorefrontThemeDocument,
  type StorefrontProductAppBlock,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { and, eq } from "drizzle-orm";
import { deps } from "../../cache-deps";
import {
  activePluginInstallationsFromRows,
  type PluginInstallation,
  selectActivePluginInstallations,
} from "../plugins";
import { planPluginRenderStoreFacts, type PluginRenderStoreFacts } from "./app-render";

export interface ProductAppContext {
  product: { id: string; slug: string; categoryId: string | null; brandId: string | null };
  /** The theme's product app blocks, in the merchant's order. */
  blocks: StorefrontProductAppBlock[];
  installations: Map<string, PluginInstallation>;
  /** `ctx.store` for the apps that draw. */
  store: PluginRenderStoreFacts;
}

/**
 * Null when no public product has this slug (the part answers 404 and is
 * never stored). One batch whether or not the theme has app blocks: the
 * store facts ride along so drawing adds no round trip. `previewTheme` (a
 * private draft or version preview) replaces the published theme's blocks.
 */
export async function readProductAppContext(db: Database, slug: string, previewTheme?: StorefrontThemeDocument): Promise<ProductAppContext | null> {
  deps.theme();
  const facts = planPluginRenderStoreFacts(db);
  const results = await safeBatch(db, [
    db.select({ value: themeSettings.colors }).from(themeSettings).where(eq(themeSettings.id, "default")).limit(1),
    db.select({ id: products.id, slug: products.slug, categoryId: products.categoryId, brandId: products.brandId })
      .from(products)
      .innerJoin(productBuyerState, and(eq(productBuyerState.productId, products.id), eq(productBuyerState.isPublic, true)))
      // A localized handle names its product too (MARKETS-DESIGN D9).
      .where(productBySlugCondition(slug, null))
      .limit(1),
    // Every active app (`plg:*`): which apps draw is decided per block below.
    selectActivePluginInstallations(db),
    ...facts.statements,
  ]);
  const [themeRows, productRows, pluginRows] = results;
  const product = (productRows as ProductAppContext["product"][])[0];
  if (!product) return null;
  deps.product(product.id);
  // Which product a handle names: its localized handles, and the handle space when a localized one named it.
  deps.localizedHandles("product", product.id);
  if (product.slug !== slug) deps.localizedSlugSpace("product");
  const theme = previewTheme ?? parseStoredStorefrontThemeDocument((themeRows as Array<{ value?: string }>)[0]?.value) ?? DEFAULT_STOREFRONT_THEME;
  return {
    product,
    blocks: theme.blocks.product.apps ?? [],
    installations: activePluginInstallationsFromRows(pluginRows as PluginInstallationRow[]),
    store: await facts.resolve(results, 3),
  };
}
