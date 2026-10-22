import { collectObjectBindingRequests, resolvePluginSettingBindings, type BindingResource, type SettingBindings } from "@scalius/shared/storefront-theme/bindings";
import { planStorefrontObjects, type PublicObjectBindings, type StorefrontObjectLoader } from "../objects";
import { objectTypeId, parseObjectTypeHandle } from "@scalius/shared/plugins/objects";
import type { PluginManifest } from "@scalius/shared/plugins/manifest";
// The data of app component sections (packages/plugin-sdk/docs/storefront.md): a
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
import { planCollectionProducts, planHomeProductLists, planProductCardFields, priceCardRowsInResults } from "../catalog";
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
  bindings?: SettingBindings;
  resource?: BindingResource;
  reads?: PluginManifest["storefront"]["sections"][number]["reads"];
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
  objects?: PublicObjectBindings;
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
  cardFields: readonly string[] = [],
  loadObjects?: StorefrontObjectLoader,
): Promise<Array<{ sectionId: string; component: HomepageAppComponent }>> {
  if (placements.length === 0) { void loadObjects?.([]); return []; }
  const translation = translationScopeOf(pricing);
  const initial = placements.map((placement) => ({ placement, values: resolvePluginSettingValues(placement.schema, placement.values) }));
  const objectRequests = initial.flatMap(({ placement, values }) => (placement.reads ?? []).flatMap((read) => {
    const qualified = read.object.includes(".") ? read.object : `${placement.pluginId}.${read.object}`;
    const type = parseObjectTypeHandle(qualified);
    if (!type) return [];
    const where = Object.fromEntries(Object.entries(read.where ?? {}).map(([key, value]) => [key, value && typeof value === "object" ? values[value.setting] : value]));
    if (Object.values(where).some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))) return [];
    return [{ typeId: objectTypeId(type.namespace, type.type), limit: read.limit, where: where as Record<string, string | number | boolean | null> }];
  }));
  const bindingRequests = collectObjectBindingRequests(placements).map(({ namespace, type, handles }) => ({ typeId: objectTypeId(namespace, type), limit: 24, handles }));
  const sharedObjects = loadObjects?.([...objectRequests, ...bindingRequests]);
  const objectPlan = planStorefrontObjects(db, sharedObjects ? [] : [...objectRequests, ...bindingRequests]);
  const bindingData: { mediaIds: string[]; bindingObjects: PublicObjectBindings } | null = bindingRequests.length > 0
    ? sharedObjects ? { mediaIds: [], bindingObjects: await sharedObjects } : objectPlan.resolve(await safeBatch(db, objectPlan.statements), 0)
    : null;
  const objectStatements = bindingData ? [] : objectPlan.statements;

  const resolved = initial.map(({ placement, values: literal }) => {
    const values = resolvePluginSettingBindings(placement.schema, literal, placement.bindings, { objects: bindingData?.bindingObjects, resource: placement.resource });
    const boundNeeds = storefrontSettingNeeds(placement.schema, values);
    const literalNeeds = storefrontSettingNeeds(placement.schema, literal);
    const products = new Map<string, number>();
    for (const need of [...boundNeeds.products, ...literalNeeds.products]) products.set(need.source, Math.max(products.get(need.source) ?? 0, need.limit));
    return { placement, literal, values, needs: { mediaIds: [...new Set([...boundNeeds.mediaIds, ...literalNeeds.mediaIds])], products: [...products].map(([source, limit]) => ({ source, limit })) } };
  });

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
    const ids = /^products:([A-Za-z0-9_,:-]+)$/.exec(key)?.[1]?.split(",").filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value)).slice(0, 36);
    return id ? [{ key, ids: [id] }] : ids?.length ? [{ key, ids }] : [];
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
  const manual = (ids: string[]) => normalizeCollectionConfig({ source: "manual", productIds: ids, categoryIds: [], maxProducts: ids.length, title: "", subtitle: "" });
  const pickedPlan = planCollectionProducts(db, picked.map(({ key, ids }) => ({ key, config: manual(ids), maxProducts: ids.length })), translation);
  const fieldsPlan = planProductCardFields(db, [...listPlan.productIdQueries, ...pickedPlan.productIdQueries], cardFields);
  const objectOffset = mediaPlan.statements.length + listPlan.statements.length + pickedPlan.statements.length + fieldsPlan.statements.length;
  const statements = [...mediaPlan.statements, ...listPlan.statements, ...pickedPlan.statements, ...fieldsPlan.statements, ...objectStatements, ...collectionRead];
  const results: unknown[] = statements.length > 0 ? [...await safeBatch(db, statements as Parameters<typeof safeBatch>[1])] : [];
  const market = await marketPriceContextOf(pricing);
  const listOffset = mediaPlan.statements.length;
  const pickedOffset = listOffset + listPlan.statements.length;
  const fields = fieldsPlan.resolve(results, pickedOffset + pickedPlan.statements.length);
  await priceCardRowsInResults(db, market, results, [
    ...listPlan.productRowSlots.map((slot) => listOffset + slot),
    ...pickedPlan.productRowSlots.map((slot) => pickedOffset + slot),
  ]);
  const media = new Map(mediaPlan.resolve(results, 0).map((asset) => [asset.id, asset]));
  const products = new Map<string, unknown[]>(
    listPlan.resolve(results, listOffset, marketShopAmounts(market), fields).map((list) => [list.key, list.products]),
  );
  const pickedResults = results.slice(pickedOffset, pickedOffset + pickedPlan.statements.length);
  for (const [key, result] of pickedPlan.resolve(pickedResults, marketShopAmounts(market), fields)) products.set(key, result.products);

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
      const collectionFields = planProductCardFields(db, plan.productIdQueries, cardFields);
      const collectionResults = [...await safeBatch(db, [...plan.statements, ...collectionFields.statements] as Parameters<typeof safeBatch>[1])];
      await priceCardRowsInResults(db, market, collectionResults, plan.productRowSlots);
      for (const [key, result] of plan.resolve(collectionResults, marketShopAmounts(market), collectionFields.resolve(collectionResults, plan.statements.length))) products.set(key, result.products);
    }
  }


  const objectData = bindingData ?? objectPlan.resolve(results, objectOffset);
  const objects = sharedObjects ? await sharedObjects : objectData.bindingObjects;
  if (sharedObjects) for (const data of Object.values(objects)) for (const record of data.records) for (const [key, type] of Object.entries(data.fields)) {
    const value = record.data[key];
    if (type === "media_reference" && typeof value === "string") objectData.mediaIds.push(value);
    if (type === "list.media_reference" && Array.isArray(value)) objectData.mediaIds.push(...value.filter((id): id is string => typeof id === "string"));
  }
  const objectMedia = planHomeMedia(db, objectData.mediaIds.filter((id) => !media.has(id)).slice(0, HOME_MAX_MEDIA));
  if (objectMedia.statements.length) for (const asset of objectMedia.resolve(await safeBatch(db, objectMedia.statements), 0)) media.set(asset.id, asset);
  const readyMedia = new Set(media.keys());
  return resolved.map(({ placement, literal, needs }) => {
    const values = { ...resolvePluginSettingBindings(placement.schema, literal, placement.bindings, {
      objects, resource: placement.resource, mediaIds: readyMedia,
    }) };
    for (const field of placement.schema) {
      if (values[field.key] === literal[field.key] || !["image", "product", "products"].includes(field.type)) continue;
      const target = storefrontSettingNeeds([field], values);
      if (target.mediaIds.some((id) => !media.has(id)) || target.products.some(({ source }) => !(products.get(source)?.length))) values[field.key] = literal[field.key] ?? null;
    }
    return {
    sectionId: placement.sectionId,
    component: {
      pluginId: placement.pluginId,
      type: placement.type,
      values,
      ...((placement.reads?.length ?? 0) > 0 ? { objects: Object.fromEntries((placement.reads ?? []).flatMap((read) => {
        const type = read.object.includes(".") ? read.object : `${placement.pluginId}.${read.object}`;
        const data = objects[type];
        if (!data) return [];
        const records = data.records.filter((record) => Object.entries(read.where ?? {}).every(([key, value]) => record.data[key] === (value && typeof value === "object" ? values[value.setting] : value))).slice(0, read.limit);
        return [[type, { ...data, records }]];
      })) } : {}),
      media: [...new Set([...needs.mediaIds, ...objectData.mediaIds])].slice(0, HOME_MAX_MEDIA).flatMap((id) => media.get(id) ?? []),
      lists: needs.products.map(({ source }) => ({ source, products: products.get(source) ?? [] })),
    },
    };
  });
}
