// The data of app component sections (docs/STOREFRONT-COMPONENTS.md): a
// section an app's storefront module draws at the edge gets its settings
// resolved there, from the images, product lists and picked products read
// here in one batch. It runs after the apps' read (beside the page's second
// batch), which names the settings schemas: one more wave for a page with
// component sections, and one more again for a collection source, whose
// rules are read first (storefront-render-budget.test.ts measures both).
// The cards are the homepage lists' cards (same projection, prices in the
// page's market, translations), so the storefront maps them as it maps its own.

import { collections } from "@scalius/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  resolvePluginSettingValues,
  storefrontSettingNeeds,
  type PluginSettingValues,
  type PluginSettingsSchema,
} from "@scalius/shared/plugins";
import {
  HOME_MAX_MEDIA,
  HOME_MAX_PRODUCT_LISTS,
  parseStorefrontProductSourceKey,
  type HomeProductListRequest,
} from "@scalius/shared/storefront-theme";
import { planCollectionProducts, planHomeProductLists, priceCardRowsInResults } from "../catalog";
import { normalizeCollectionConfig } from "../collections";
import { marketPriceContextOf, marketShopAmounts, type MarketPricing } from "../price-lists";
import { translationScopeOf } from "../translations";
import { deps } from "../../cache-deps";
import { planHomeMedia, type HomeMediaAsset } from "./homepage-sections";

/** One component section of a page, with its app's settings schema. */
export interface AppComponentPlacement {
  sectionId: string;
  pluginId: string;
  type: string;
  schema: PluginSettingsSchema;
  values: unknown;
}

/** What the storefront needs to draw one component section. */
export interface HomepageAppComponent {
  pluginId: string;
  type: string;
  /** The stored values resolved against the app's schema as it is now. */
  values: PluginSettingValues;
  /** The images its settings name, by media id. */
  media: HomeMediaAsset[];
  /** Its `products` settings' lists, by source key (`newest`, `collection:<id>`). */
  lists: Array<{ source: string; products: unknown[] }>;
}

/**
 * The images and product lists of these component sections, in one batch
 * (two when a source is a collection). Lists are shared between sections
 * that name the same source; each section gets its own.
 */
export async function readAppComponentData(
  db: Database,
  placements: readonly AppComponentPlacement[],
  pricing: MarketPricing | null = null,
): Promise<Array<{ sectionId: string; component: HomepageAppComponent }>> {
  if (placements.length === 0) return [];
  const translation = translationScopeOf(pricing);
  const resolved = placements.map((placement) => ({
    placement,
    values: resolvePluginSettingValues(placement.schema, placement.values),
    needs: storefrontSettingNeeds(placement.schema, placement.values),
  }));

  // Every image and list the page's component sections name, within the homepage's bounds.
  const mediaIds = [...new Set(resolved.flatMap((entry) => entry.needs.mediaIds))].slice(0, HOME_MAX_MEDIA);
  const limits = new Map<string, number>();
  for (const entry of resolved) {
    for (const { source, limit } of entry.needs.products) limits.set(source, Math.max(limits.get(source) ?? 0, limit));
  }
  const sources = [...limits].slice(0, HOME_MAX_PRODUCT_LISTS);
  const lists: HomeProductListRequest[] = sources.flatMap(([key, limit]) => {
    const source = parseStorefrontProductSourceKey(key);
    return source ? [{ key, source, limit: Math.min(limit, 36) }] : [];
  });
  // Picked products (`product` settings): read by id as a manual collection of one.
  const picked = sources.flatMap(([key]) => {
    const id = /^product:([A-Za-z0-9_-]{1,64})$/.exec(key)?.[1];
    return id ? [{ key, id }] : [];
  });
  const collectionLists = lists.filter((list) => list.source.kind === "collection");
  const otherLists = lists.filter((list) => list.source.kind !== "collection");
  const collectionIds = collectionLists.map((list) => (list.source as { collectionId: string }).collectionId);
  if (collectionIds.length > 0) deps.collections(collectionIds);

  const mediaPlan = planHomeMedia(db, mediaIds);
  const listPlan = planHomeProductLists(db, otherLists, translation);
  const collectionRead = collectionIds.length > 0
    ? [db.select({ id: collections.id, config: collections.config }).from(collections)
      .where(and(eq(collections.isActive, true), isNull(collections.deletedAt), inArray(collections.id, collectionIds)))]
    : [];
  // Picked products need nothing read first: they join the first batch.
  const manual = (id: string) => normalizeCollectionConfig({ source: "manual", productIds: [id], categoryIds: [], maxProducts: 1, title: "", subtitle: "" });
  const pickedPlan = planCollectionProducts(db, picked.map(({ key, id }) => ({ key, config: manual(id), maxProducts: 1 })), translation);
  const statements = [...mediaPlan.statements, ...listPlan.statements, ...pickedPlan.statements, ...collectionRead];
  const results: unknown[] = statements.length > 0 ? [...await safeBatch(db, statements as Parameters<typeof safeBatch>[1])] : [];
  const market = await marketPriceContextOf(pricing);
  const listOffset = mediaPlan.statements.length;
  const pickedOffset = listOffset + listPlan.statements.length;
  await priceCardRowsInResults(db, market, results, [
    ...listPlan.productRowSlots.map((slot) => listOffset + slot),
    ...pickedPlan.productRowSlots.map((slot) => pickedOffset + slot),
  ]);
  const media = new Map(mediaPlan.resolve(results, 0).map((asset) => [asset.id, asset]));
  const products = new Map<string, unknown[]>(
    listPlan.resolve(results, listOffset, marketShopAmounts(market)).map((list) => [list.key, list.products]),
  );
  const pickedResults = results.slice(pickedOffset, pickedOffset + pickedPlan.statements.length);
  for (const [key, result] of pickedPlan.resolve(pickedResults, marketShopAmounts(market))) products.set(key, result.products);

  // Collection sources (their products by each collection's own rules) need
  // the collection's rules first: a second batch, only when a section names one.
  if (collectionRead.length > 0) {
    const rows = results[results.length - 1] as Array<{ id: string; config: unknown }>;
    const configs = new Map(rows.map((row) => [row.id, normalizeCollectionConfig(row.config)]));
    const plan = planCollectionProducts(db, collectionLists.flatMap((list) => {
      const config = configs.get((list.source as { collectionId: string }).collectionId);
      return config ? [{ key: list.key, config, maxProducts: list.limit }] : [];
    }), translation);
    if (plan.statements.length > 0) {
      const collectionResults = [...await safeBatch(db, plan.statements as Parameters<typeof safeBatch>[1])];
      await priceCardRowsInResults(db, market, collectionResults, plan.productRowSlots);
      for (const [key, result] of plan.resolve(collectionResults, marketShopAmounts(market))) products.set(key, result.products);
    }
  }


  return resolved.map(({ placement, values, needs }) => ({
    sectionId: placement.sectionId,
    component: {
      pluginId: placement.pluginId,
      type: placement.type,
      values,
      media: needs.mediaIds.flatMap((id) => media.get(id) ?? []),
      lists: needs.products.map(({ source }) => ({ source, products: products.get(source) ?? [] })),
    },
  }));
}
