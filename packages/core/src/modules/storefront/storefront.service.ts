import { collectObjectBindingRequests } from "@scalius/shared/storefront-theme/bindings";
import { objectTypeId } from "@scalius/shared/plugins/objects";
import { resourceProductFieldsSql, readResourceProductFields, type BindingResourceSelector } from "./resource-bindings";
import type { BindingResource } from "@scalius/shared/storefront-theme/bindings";
// src/modules/storefront/storefront.service.ts
// Data query and shaping functions for the storefront API.
// Extracted from src/server/routes/storefront.ts — zero logic changes.
//
// These functions perform the heavy batched D1 queries and normalise the data.
// Route handlers simply call a function and return c.json(result).

import {
  collections,
  analytics,
  themeSettings,
  categories,
  productBuyerState,
  products,
} from "@scalius/database/schema";
import { eq, isNull, and, inArray, sql } from "drizzle-orm";
import { pickProductPageCopy } from "@scalius/shared/checkout-language";
import {
  normalizeCloudflareWebAnalyticsConfig,
  processAnalyticsScript,
  shouldInjectAnalyticsScript,
  shouldUsePartytown,
} from "../analytics";
import {
  type HomeProductList,
  planCollectionProducts,
  planHomeBrands,
  planHomeProductLists,
  planProductCardFields,
  priceCardRowsInResults,
} from "../catalog";
import { planHomeMedia, planHomePromotions, planPublishedThemeBrandMedia } from "./homepage-sections";
import type { HomepageAppComponent } from "./app-components";
import { marketPriceContextOf, marketShopAmounts, type MarketPricing } from "../price-lists";
import { normalizeCollectionConfig, publicCollectionConfig } from "../collections";
import {
  businessDocument,
  currencyDocument,
  mediaDocument,
  metaConversionsDocument,
  policiesDocument,
  securityDocument,
  seoDocument,
} from "../settings";
import { getPublicPageBySlug, planPublicStorePolicies } from "../pages";
import { planStorefrontObjects, type PublicObjectBindings, type StorefrontObjectRequest, type StorefrontObjectLoader } from "../objects";
import {
  selectSettingsDocuments,
  type SettingsDocumentRow,
} from "../../settings-store";
import {
  DEFAULT_STOREFRONT_THEME,
  HOME_MAX_MEDIA,
  homeSectionRequests,
  parseStoredStorefrontThemeDocument,
  storefrontThemeTextOf,
  translateStorefrontTheme,
  type HomeAppSectionRequest,
  type StorefrontThemeText,
  type HomeSectionRequests,
  type StorefrontPageTemplate,
} from "@scalius/shared/storefront-theme";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { currencySymbol } from "@scalius/shared/money-format";
import { marketOfPresence } from "@scalius/shared/markets";
import { marketCurrencyIncrementMinor } from "@scalius/shared/presentment";
import { safeBatch, type Database } from "@scalius/database/client";
import { selectStoreShapeCounts, storeShapeFromCounts, type StoreShapeCountsRow } from "./store-shape";
import {
  categoryNavigationFromRows,
  planNavigationResourceSnapshots,
  planPublishedNavigationPlacements,
  selectCategoryNavigationRows,
  trimCategoryNavigation,
} from "../navigation";
import { publicCategoryConditions } from "../categories";
import {
  activePluginInstallationsFromRows,
  activePluginPurchaseOptions,
  activePluginStorefrontExtensions,
  activePluginStorefrontScripts,
  selectActivePluginInstallations,
} from "../plugins";
import type { PluginInstallationRow } from "@scalius/database/schema";
import { PLUGIN_RENDER_RETRY_SECONDS } from "@scalius/shared/plugins";
import { storefrontExtensionSettingSchemas } from "@scalius/shared/plugins/storefront-components";
import { activePluginStorefrontServices } from "./app-render";
import { deps } from "../../cache-deps";
import {
  ga4MeasurementDocument,
  tiktokEventsDocument,
  tiktokServerEnabled,
  trackingConsentDocument,
  TRACKING_SETTINGS_DOCUMENTS,
} from "../../integrations/tracking/settings";
import {
    NAME_FIELDS,
    localizedSlugSql,
    parseTranslationContext,
    pickCheckoutCopy,
    selectCheckoutCopyRows,
    translateRows,
    translationColumns,
    translationContextSql,
    translationScope,
    translationScopeOf,
    type CheckoutCopyRow,
    type TranslationScope,
} from "../translations";
import { marketMatrixFromSql, marketMatrixSql, storeCurrencyOf } from "../markets";

// ── Local helpers & interfaces ────────────────────────────────────────────────

interface NestedNavigationItem {
  id?: string;
  title: string;
  href?: string;
  imageUrl?: string;
  openInNewTab?: boolean;
  subMenu?: NestedNavigationItem[];
}

// ── Homepage data ─────────────────────────────────────────────────────────────

/** A homepage product list: its products and what it reads from (for titles and "View all"). */
export interface HomepageProductList extends HomeProductList {
  /** A collection list's collection (active collections only). */
  collection: { id: string; title: string } | null;
}

type BatchItem = Parameters<typeof safeBatch>[1][number];

/** A category the category tiles show: published, not in trash. */
export interface HomepageCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  canonicalPath: string | null;
}

/**
 * One statement for the category tiles: the requested ids that are public
 * categories, returned in request order. Any of them may be published,
 * renamed or trashed later, so each id is a dependency.
 */
function planHomeCategories(db: Database, ids: readonly string[], translation: TranslationScope | null) {
  if (ids.length === 0) return { statements: [] as BatchItem[], resolve: (): HomepageCategory[] => [] };
  deps.categories(ids);
  const statement = db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
      imageUrl: categories.imageUrl,
      canonicalPath: categories.canonicalPath,
      ...translationColumns(translation, "category", categories.id),
    })
    .from(categories)
    .where(and(
      ...publicCategoryConditions(),
      sql`${categories.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`,
    ));
  return {
    statements: [statement] as BatchItem[],
    resolve(results: readonly unknown[], offset: number): HomepageCategory[] {
      const rows = translateRows(translation, "category", results[offset] as HomepageCategory[], { name: "name", description: "description" });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    },
  };
}

/**
 * A product homepage's product, only while it is public (the buyer state
 * projection's single-sourced rule); otherwise null, and `/` renders the
 * sections. Planned only for a product home mode, so a sections homepage
 * reads no product row for it.
 */
function planHomeProduct(db: Database, productId: string | null, translation: TranslationScope | null) {
  deps.product(productId);
  const statement = productId === null ? null : db
    .select({ id: products.id, slug: products.slug, ...(translation ? { trSlug: localizedSlugSql(translation, "product", products.id) } : {}) })
    .from(products)
    .innerJoin(productBuyerState, and(
      eq(productBuyerState.productId, products.id),
      eq(productBuyerState.isPublic, true),
    ))
    .where(eq(products.id, productId))
    .limit(1);
  return {
    statements: (statement ? [statement] : []) as BatchItem[],
    resolve(results: readonly unknown[], offset: number): { id: string; slug: string } | null {
      const row = statement ? (results[offset] as Array<{ id: string; slug: string; trSlug?: string | null }>)[0] ?? null : null;
      if (!row) return null;
      // A presence redirects to the product's handle in its language.
      if (translation !== null) deps.translation("product", row.id);
      return { id: row.id, slug: row.trSlug || row.slug };
    },
  };
}

/**
 * Fetch and shape all homepage data in two batched D1 round trips, from
 * the theme document alone (its sections and home mode say what to read).
 *
 * 1. The SEO document, the active collections (metadata only) and, unless
 *    the caller passes the requests, the published theme.
 * 2. One batch with every product list (the collections sections'
 *    collections and the section sources), each with the card media of
 *    exactly its rows, the section images (hero slides included), the
 *    category tiles' categories, the brand wall's brands, the deal
 *    countdowns' promotions and a product homepage's product.
 *
 * `requests` (a preview's draft, `homeSectionRequests(draft.pages.home,
 * draft.pages.homeMode)`) replaces the published theme's.
 */
/** One app section: a component section the storefront draws at the edge from `component` (app-components.ts). */
export interface HomepageAppSection {
  sectionId: string;
  component: HomepageAppComponent;
}

export async function getHomepageData(
  db: Database,
  options: {
    requests?: HomeSectionRequests;
    /**
     * A landing page (`pages.landing[slug]`): its sections through the same
     * bounded planner instead of the homepage's, without the homepage SEO read.
     */
    pageSlug?: string;
    /**
     * A page template (`pages.templates[template]`): the sections around a
     * product, listing, cart or CMS page's fixed part, the same way as a
     * landing page.
     */
    template?: StorefrontPageTemplate;
    /**
     * Draws the page's app sections (the API's plugin host); runs beside the
     * second batch, so a homepage with app sections adds no wave before its
     * apps' own reads. Without it, app sections draw nothing.
     */
    renderApps?: (requests: HomeAppSectionRequest[], page: {
      pricing: MarketPricing | null;
      cardFields: string[];
      loadObjects: StorefrontObjectLoader;
      resource?: BindingResource;
      /** The theme's words in the page's language: translate the sections' text settings with it (none at the root). */
      text?: StorefrontThemeText;
    }) => Promise<HomepageAppSection[]>;
    resource?: BindingResourceSelector;
    /** A presence page's market pricing (MARKETS-DESIGN D5); null at the root. */
    pricing?: MarketPricing | null;
  } = {},
) {
  // A presence page's sections in its language (MARKETS-DESIGN D9); none at the root.
  const translation = translationScopeOf(options.pricing);
  // Explicit preview requests already identify every collection they need.
  // Published pages still discover their requests from the saved theme below.
  const requestedCollectionIds = options.requests ? [...new Set([
    ...options.requests.collectionIds,
    ...options.requests.lists.flatMap((list) => list.source.kind === "collection" ? [list.source.collectionId] : []),
  ])] : null;
  // === BATCH 1: Independent top-level queries ===
  const batchResults = await safeBatch(db, [
    // 0. SEO document (homepage title and description)
    ...(options.pageSlug || options.template ? [] : [selectSettingsDocuments(db, [seoDocument])]),

    // 1. Active collections (metadata only): the ones the sections name.
    db
      .select({
        id: collections.id,
        name: collections.name,
        presentation: collections.presentation,
        config: collections.config,
        sortOrder: collections.sortOrder,
        isActive: collections.isActive,
        ...translationColumns(translation, "collection", collections.id, { slug: false }),
      })
      .from(collections)
      .where(and(eq(collections.isActive, true), isNull(collections.deletedAt),
        requestedCollectionIds === null ? undefined
          : requestedCollectionIds.length ? inArray(collections.id, requestedCollectionIds) : sql`false`))
      .orderBy(collections.sortOrder),

    // 2. The published theme: its sections and home mode name the reads. A
    // presence folds in which of the theme's translations apply (none at the root).
    db
      .select({
        value: themeSettings.colors,
        ...(options.resource ? { bindingResource: resourceProductFieldsSql(options.resource) } : {}),
        ...(translation && !options.requests ? { textContext: translationContextSql(translation) } : {}),
      })
      .from(themeSettings)
      .where(eq(themeSettings.id, "default"))
      .limit(1),
  ]);
  deps.theme();

  const collectionResults = batchResults[batchResults.length - 2];
  const themeResults = batchResults[batchResults.length - 1];
  const resource = readResourceProductFields((themeResults as Array<{ bindingResource?: string }>)[0]?.bindingResource);
  const seo = options.pageSlug || options.template ? null : await seoDocument.fromRows(batchResults[0] as SettingsDocumentRow[]);
  // Unset copy stays null: the storefront titles the homepage with the
  // store name instead of inventing a platform-branded headline.
  const seoSettings = {
    homepageTitle: seo?.value.homepageTitle.trim() || null,
    homepageMetaDescription: seo?.value.homepageMetaDescription.trim() || null,
  };
  // An unreadable theme renders the default whole (as the layout read does),
  // in the page's words (a landing page's title and its sections' text).
  const themeRow = (themeResults as Array<{ value?: string; textContext?: unknown }>)[0];
  const storedTheme = parseStoredStorefrontThemeDocument(themeRow?.value) ?? DEFAULT_STOREFRONT_THEME;
  // A preview names its own sections; their words stay the draft's.
  const text = translation && !options.requests
    ? storefrontThemeTextOf(storedTheme, parseTranslationContext(themeRow?.textContext))
    : null;
  const theme = translateStorefrontTheme(storedTheme, text);
  const landing = options.pageSlug ? theme.pages.landing[options.pageSlug] ?? null : null;
  const pageSections = options.template ? theme.pages.templates[options.template].sections : landing?.sections;
  const requests = options.requests ?? (options.pageSlug || options.template
    ? homeSectionRequests(pageSections ?? [], { kind: "sections" })
    : homeSectionRequests(theme.pages.home, theme.pages.homeMode));
  // A landing page or template depends on the collections its sections name; the homepage on any.
  if (options.pageSlug || options.template) deps.collections([
    ...requests.collectionIds,
    ...requests.lists.flatMap((list) => list.source.kind === "collection" ? [list.source.collectionId] : []),
  ]);
  else deps.anyCollection();
  // The apps draw their sections while batch 2 reads the platform sections' data.
  let declareAppObjects!: (requests: readonly StorefrontObjectRequest[]) => void;
  let resolveAppObjects!: (objects: PublicObjectBindings) => void;
  const appObjectRequests = new Promise<readonly StorefrontObjectRequest[]>((resolve) => { declareAppObjects = resolve; });
  const appObjectData = new Promise<PublicObjectBindings>((resolve) => { resolveAppObjects = resolve; });
  const loadObjects: StorefrontObjectLoader = (reads) => { declareAppObjects(reads); return appObjectData; };
  let previewAppFailed = false;
  const appSections: Promise<HomepageAppSection[]> = (requests.apps ?? []).length > 0 && options.renderApps
    ? options.renderApps(requests.apps ?? [], { pricing: options.pricing ?? null, cardFields: theme.blocks.card.fields ?? [], loadObjects, resource, ...(text ? { text } : {}) }).then((sections) => { declareAppObjects([]); return sections; }).catch((error: unknown) => {
      declareAppObjects([]);
      // A preview must retain its previous DOM and report failure, not erase
      // an app section because a required dependency temporarily failed.
      if (options.requests) { previewAppFailed = true; return []; }
      console.warn(`[Storefront] App sections could not be drawn (${error instanceof Error ? error.name : "error"}).`);
      // Draw the page without them, and try them again soon.
      deps.validUntil(Date.now() + PLUGIN_RENDER_RETRY_SECONDS * 1000);
      return [];
    })
    : (declareAppObjects([]), Promise.resolve([]));

  // === BATCH 2: every product list, its card media, section images ===
  const activeCollections = translateRows(
    translation,
    "collection",
    collectionResults as Array<Record<string, unknown> & { id: string }>,
    NAME_FIELDS,
  ).map((col) => ({
    id: col.id as string,
    name: col.name as string,
    presentation: col.presentation as string,
    sortOrder: col.sortOrder as number,
    isActive: col.isActive as boolean,
    parsedConfig: normalizeCollectionConfig(col.config),
  }));
  const collectionById = new Map(activeCollections.map((collection) => [collection.id, collection]));
  // The collections sections' collections, in their order; one that is gone
  // or inactive is skipped (its col:* dependency brings it back).
  const sectionCollections = requests.collectionIds.flatMap((id) => collectionById.get(id) ?? []);
  const collectionLists = requests.lists.flatMap((list) => {
    const collection = list.source.kind === "collection" ? collectionById.get(list.source.collectionId) : undefined;
    return collection ? [{ list, collection }] : [];
  });
  const collectionPlan = planCollectionProducts(db, [
    ...sectionCollections.map((col) => ({ key: `section:${col.id}`, config: col.parsedConfig })),
    ...collectionLists.map(({ list, collection }) => ({ key: list.key, config: collection.parsedConfig, maxProducts: list.limit })),
  ], translation);
  const listPlan = planHomeProductLists(db, requests.lists.filter((list) => list.source.kind !== "collection"), translation);
  const mediaPlan = planHomeMedia(db, requests.mediaIds);
  const brandPlan = planHomeBrands(db, requests.brandLimit, translation);
  const promotionPlan = planHomePromotions(db, requests.promotionIds);
  const categoryPlan = planHomeCategories(db, requests.categoryIds, translation);
  const productPlan = planHomeProduct(db, requests.homeProductId, translation);
  const bindingTypes = [...requests.bindingObjects ?? [], ...collectObjectBindingRequests({ blocks: theme.blocks, apps: theme.apps })];
  const objectPlan = planStorefrontObjects(db, [
    ...(requests.objects ?? []),
    ...await appObjectRequests,
    ...bindingTypes.map(({ namespace, type, handles }) => ({ typeId: objectTypeId(namespace, type), limit: 24, handles })),
  ]);
  const cardFieldsPlan = planProductCardFields(db, [...collectionPlan.productIdQueries, ...listPlan.productIdQueries], theme.blocks.card.fields ?? []);
  const statements: BatchItem[] = [
    ...collectionPlan.statements,
    ...listPlan.statements,
    ...mediaPlan.statements,
    ...brandPlan.statements,
    ...promotionPlan.statements,
    ...categoryPlan.statements,
    ...productPlan.statements,
    ...objectPlan.statements,
    ...cardFieldsPlan.statements,
  ];
  const results: unknown[] = statements.length > 0 ? [...await safeBatch(db, statements)] : [];
  const listOffset = collectionPlan.statements.length;
  // Every card in the page's market (nothing at the root or in a neutral market).
  const market = await marketPriceContextOf(options.pricing);
  await priceCardRowsInResults(db, market, results, [
    ...collectionPlan.productRowSlots,
    ...listPlan.productRowSlots.map((slot) => listOffset + slot),
  ]);
  const mediaOffset = listOffset + listPlan.statements.length;
  const brandOffset = mediaOffset + mediaPlan.statements.length;
  const promotionOffset = brandOffset + brandPlan.statements.length;
  const categoryOffset = promotionOffset + promotionPlan.statements.length;
  const productOffset = categoryOffset + categoryPlan.statements.length;
  const objectOffset = productOffset + productPlan.statements.length;
  const objects = objectPlan.resolve(results, objectOffset);
  resolveAppObjects(objects.bindingObjects);
  // Images the shown entries name and no section did: one more read, only then.
  const extraMediaIds = objects.mediaIds.filter((id) => !requests.mediaIds.includes(id)).slice(0, HOME_MAX_MEDIA);
  const extraMediaPlan = planHomeMedia(db, extraMediaIds);
  const extraMedia = extraMediaPlan.statements.length > 0
    ? extraMediaPlan.resolve(await safeBatch(db, extraMediaPlan.statements), 0)
    : [];
  const cardFields = cardFieldsPlan.resolve(results, statements.length - cardFieldsPlan.statements.length);
  const resolvedMap = collectionPlan.resolve(results, marketShopAmounts(market), cardFields);
  const productLists = listPlan.resolve(results, listOffset, marketShopAmounts(market), cardFields);

  // The collections sections' collections that have products to show.
  const formattedCollections = sectionCollections.flatMap((col) => {
    const resolved = resolvedMap.get(`section:${col.id}`);
    if (!resolved || resolved.products.length === 0) return [];
    return [{
      id: col.id,
      name: col.name,
      presentation: col.presentation,
      config: publicCollectionConfig(col.parsedConfig),
      sortOrder: col.sortOrder,
      isActive: col.isActive,
      categories: resolved.categories,
      products: resolved.products,
      featuredProduct: resolved.featuredProduct,
    }];
  });

  // Section lists in request order; a collection that is gone or inactive reads empty.
  const lists: HomepageProductList[] = requests.lists.map((list) => {
    if (list.source.kind === "collection") {
      const collection = collectionById.get(list.source.collectionId);
      const resolved = collection ? resolvedMap.get(list.key) : undefined;
      return {
        key: list.key,
        products: resolved?.products ?? [],
        category: null,
        collection: collection
          ? { id: collection.id, title: publicCollectionConfig(collection.parsedConfig).title || collection.name }
          : null,
      };
    }
    const resolved = productLists.find((each) => each.key === list.key);
    return { key: list.key, products: resolved?.products ?? [], category: resolved?.category ?? null, collection: null };
  });

  const renderedApps = await appSections;
  if (previewAppFailed) throw new Error("Preview app render failed");
  return {
    seo: seoSettings,
    ...(options.pageSlug ? { landing } : {}),
    sections: {
      lists,
      media: [...mediaPlan.resolve(results, mediaOffset), ...extraMedia],
      brands: brandPlan.resolve(results, brandOffset),
      promotions: promotionPlan.resolve(results, promotionOffset),
      categories: categoryPlan.resolve(results, categoryOffset),
      collections: formattedCollections,
      // Only while the product is public; the storefront then answers `/`
      // with a redirect to the product's own page.
      homeProduct: productPlan.resolve(results, productOffset),
      // App sections that drew something, by section id (component data).
      apps: renderedApps,
      // The Objects sections' content types with their published entries.
      // Only a page with a Objects section carries the key (other pages answer as before).
      ...(objects.types.length > 0 || (requests.objects?.length ?? 0) > 0 ? { objects: objects.types } : {}),
      ...(bindingTypes.length > 0 ? { bindingObjects: objects.bindingObjects } : {}),
    },
  };
}

// ── Landing page render data ────────────────────────────────────────────────

/** A published landing page and its sections' data; null when the live theme has no page at that slug. */
export async function getLandingPageData(
  db: Database,
  slug: string,
  options: Pick<NonNullable<Parameters<typeof getHomepageData>[1]>, "renderApps" | "pricing"> = {},
) {
  const data = await getHomepageData(db, { ...options, pageSlug: slug });
  return data.landing ? { landing: data.landing, sections: data.sections } : null;
}

/**
 * The live theme's page template sections' data (the sections around a
 * product, listing, cart or CMS page's fixed part). A template without
 * sections costs the one first batch (the theme row and the collections).
 */
export async function getTemplateSectionsData(
  db: Database,
  template: StorefrontPageTemplate,
  options: Pick<NonNullable<Parameters<typeof getHomepageData>[1]>, "renderApps" | "pricing" | "resource"> = {},
) {
  return (await getHomepageData(db, { ...options, template })).sections;
}

// ── CMS page render data ────────────────────────────────────────────────────

export async function getPageRenderData(db: Database, slug: string, translation: TranslationScope | null = null) {
  const page = await getPublicPageBySlug(db, slug, translation);
  if (!page) return null;

  return { page };
}

// ── Layout data ───────────────────────────────────────────────────────────────

/** Where the navigation plan's statements start in the layout batch. */
const LAYOUT_NAVIGATION_OFFSET = 8;

const LAYOUT_DOCUMENTS = [
  currencyDocument,
  mediaDocument,
  metaConversionsDocument,
  seoDocument,
  businessDocument,
  securityDocument,
  policiesDocument,
  // The consent banner and the server tracking destinations (audit spec S4).
  ...TRACKING_SETTINGS_DOCUMENTS,
];

function storedFlag(rows: readonly SettingsDocumentRow[], key: string): { isEnabled?: unknown } | null {
  const row = rows.find((each) => each.category === key);
  try {
    return row ? JSON.parse(row.value) as { isEnabled?: unknown } : null;
  } catch {
    return null;
  }
}

/**
 * What the storefront needs to know about tracking: the consent banner of
 * markets outside the EEA/UK/CH, whether any server destination is on (the
 * banner then shows even without a pixel), and whether TikTok takes browser
 * events (its token reads strictly; decrypted only when the stored document
 * turns it on).
 */
async function layoutTracking(
  rows: readonly SettingsDocumentRow[],
  ctx: { encryptionKey?: string },
  metaBrowserEvents: boolean,
) {
  const consent = await trackingConsentDocument.fromRows(rows, ctx);
  const ga4On = storedFlag(rows, ga4MeasurementDocument.key)?.isEnabled === true;
  const tiktokStored = storedFlag(rows, tiktokEventsDocument.key)?.isEnabled === true;
  const tiktok = tiktokStored ? await tiktokEventsDocument.fromRows(rows, ctx) : null;
  const tiktokBrowserEvents = tiktok !== null && tiktokServerEnabled(tiktok) && !tiktok.secretErrors.accessToken;
  return {
    consentOtherRegions: consent.value.otherRegions,
    serverEvents: metaBrowserEvents || ga4On || tiktokStored,
    tiktokBrowserEvents,
  };
}

/**
 * Whether the storefront sends Meta browser events: an enabled pixel whose
 * access token reads strictly. The token is decrypted only when the stored
 * document turns the pixel on (the full read then decides), so a store
 * without Meta pays no key derivation per layout read.
 */
async function metaCapiBrowserEventsEnabled(
  rows: readonly SettingsDocumentRow[],
  ctx: { encryptionKey?: string },
): Promise<boolean> {
  const row = rows.find((each) => each.category === metaConversionsDocument.key);
  let stored: { isEnabled?: unknown; pixelId?: unknown } | null = null;
  try {
    stored = row ? JSON.parse(row.value) : null;
  } catch {
    stored = null;
  }
  if (stored?.isEnabled !== true || typeof stored.pixelId !== "string" || !stored.pixelId.trim()) return false;
  const settings = await metaConversionsDocument.fromRows([row!], ctx);
  return Boolean(
    settings.value.isEnabled &&
    settings.value.pixelId.trim() &&
    settings.value.accessToken.trim(),
  );
}

/**
 * Fetch and shape all layout data in two batched D1 round trips:
 *
 * 1. Analytics, the settings documents, the published theme and its brand
 *    images, the checkout language, the store shape counts, the category
 *    tree, and the placed menus with their published items.
 * 2. The pages the linked store policies name and the resources the menu
 *    items link to (skipped when there are none).
 *
 * Returns { analytics, navigation, footerMenus, categoryTree, currency,
 * theme, brand, storeShape, ..., cspAllowedDomains }. The look (logo,
 * announcement, footer words) is the theme document and its brand images;
 * identity (name, phone, email, address, social profiles) is `business`.
 */
export async function getLayoutData(
  db: Database,
  options: {
    credentialEncryptionKey?: string;
    /**
     * The page's presence (MARKETS-DESIGN D9): its menus, category tree,
     * policies and storefront copy in its language. None at the root.
     */
    presence?: string | null;
  } = {},
) {
  const translation = translationScope(options.presence);
  const brandMedia = planPublishedThemeBrandMedia(db);
  const navigationPlan = planPublishedNavigationPlacements(db, translation);
  const batchResults = await db.batch([
    // 0. Analytics configurations
    db.select({
      id: analytics.id,
      type: analytics.type,
      isActive: analytics.isActive,
      usePartytown: analytics.usePartytown,
      config: analytics.config,
      location: analytics.location,
    }).from(analytics).where(and(eq(analytics.isActive, true), isNull(analytics.deletedAt))),

    // 1. Settings documents the layout projects
    selectSettingsDocuments(db, LAYOUT_DOCUMENTS),

    // 2. Published theme (and, at a presence, which of its translations apply)
    db
      .select({ value: themeSettings.colors, ...(translation ? { textContext: translationContextSql(translation) } : {}) })
      .from(themeSettings)
      .where(eq(themeSettings.id, "default"))
      .limit(1),

    // 3. The checkout copy of the page's language (the store default
    // language at the root) for storefront buyer copy
    selectCheckoutCopyRows(db, translation?.locale ?? null),

    // 4. Store shape counts for the theme fit rules (bounded, one statement),
    // and in the same row the active market matrix with the backup market's
    // price increment (MARKETS-DESIGN D4)
    selectStoreShapeCounts(db, { marketMatrix: marketMatrixSql() }),

    // 5. The reachable category tree: automatic departments and /categories (bounded)
    selectCategoryNavigationRows(db, undefined, translation),

    // 6. The published theme's brand images (logo, footer logo, tab icon)
    brandMedia.statement,

    // 7. Active apps (their approved storefront scripts)
    selectActivePluginInstallations(db),

    // 8-9. The placement manifest and the placed menus' published items
    ...navigationPlan.statements,
  ]);

  deps.analytics();
  deps.theme();
  const [
    analyticsResults,
    documentRows,
    themeResults,
    checkoutLanguageResults,
    storeShapeResults,
    categoryNavigationRows,
    brandMediaRows,
    activePluginRows,
  ] = batchResults;
  const rows = documentRows as SettingsDocumentRow[];
  const activeApps = activePluginInstallationsFromRows(activePluginRows as PluginInstallationRow[]);
  const ctx = { encryptionKey: options.credentialEncryptionKey };
  const [currency, media, browserEventsEnabled, seo, business, security, policies] = await Promise.all([
    currencyDocument.fromRows(rows, ctx),
    mediaDocument.fromRows(rows, ctx),
    metaCapiBrowserEventsEnabled(rows, ctx),
    seoDocument.fromRows(rows, ctx),
    businessDocument.fromRows(rows, ctx),
    securityDocument.fromRows(rows, ctx),
    policiesDocument.fromRows(rows, ctx),
  ]);

  // Navigation is independently versioned presentation. A corrupt placement
  // must not take down checkout, account, or the rest of the storefront.
  let placedNavigation: ReturnType<typeof navigationPlan.resolve> | null = null;
  try {
    placedNavigation = navigationPlan.resolve(batchResults, LAYOUT_NAVIGATION_OFFSET);
  } catch {
    console.warn("[Storefront] Published navigation could not be loaded.");
  }

  // === BATCH 2: policy pages and the menus' linked resources ===
  // Only linked policies whose pages are published.
  const policyPlan = planPublicStorePolicies(db, policies.value, translation);
  const resourcePlan = planNavigationResourceSnapshots(db, placedNavigation?.targets ?? [], translation);
  const secondStatements: BatchItem[] = [...policyPlan.statements, ...resourcePlan.statements];
  const secondResults = secondStatements.length > 0 ? await safeBatch(db, secondStatements) : [];
  const publicPolicies = policyPlan.resolve(secondResults, 0);
  // Process Analytics
  const processedAnalytics = analyticsResults
    .filter(shouldInjectAnalyticsScript)
    .map((script) => {
      let processedConfig = script.type === "cloudflare_web_analytics"
        ? normalizeCloudflareWebAnalyticsConfig(script.config)
        : script.config;
      const usePartytown = shouldUsePartytown({
        ...script,
        config: processedConfig,
      });
      if (usePartytown)
        processedConfig = processAnalyticsScript({
          ...script,
          config: processedConfig,
        });
      return {
        id: script.id,
        type: script.type,
        usePartytown,
        config: processedConfig,
        location: script.location,
      };
    });

  // Process Header + Navigation
  let navigationPlacements: ReturnType<NonNullable<typeof placedNavigation>["publish"]> = [];
  try {
    navigationPlacements = placedNavigation?.publish(
      resourcePlan.resolve(secondResults, policyPlan.statements.length),
    ) ?? [];
  } catch {
    console.warn("[Storefront] Published navigation could not be loaded.");
  }
  const headerPlacement = navigationPlacements.find((placement) => (
    placement.surface === "header" && placement.slot === "primary"
  ));
  const footerPlacements = navigationPlacements.filter((placement) => (
    placement.surface === "footer" && placement.slot === "column"
  ));
  const footerMenus = footerPlacements.map((placement) => ({
    id: placement.id,
    title: placement.labelOverride || placement.menuName,
    links: placement.items,
  }));
  const navigationData = (headerPlacement?.items ?? []) as NestedNavigationItem[];

  // Every active market's countries and presences: hreflang, the market
  // selector and the presence a page renders (MARKETS-DESIGN D4).
  const { matrix: marketMatrix, backupPriceIncrementMinor } = marketMatrixFromSql(
    (storeShapeResults as Array<{ marketMatrix?: unknown }>)[0]?.marketMatrix,
  );
  // The ISO 4217 places the storefront formats prices and UCP amounts with
  // (0 for JPY, 3 for KWD), from the same helper checkout prices with.
  // A presence of a market in its own currency (MARKETS-DESIGN step 6) shows
  // that currency: its symbol, places and increment (the matrix carries it,
  // so this reads nothing more). The root and every market in the shop
  // currency show the shop currency, as before.
  const presenceCurrency = options.presence
    ? marketOfPresence(marketMatrix, options.presence)?.market.currencyCode ?? null
    : null;
  const currencyData = presenceCurrency && presenceCurrency !== currency.value.currencyCode
    ? {
      code: presenceCurrency,
      symbol: currencySymbol(presenceCurrency),
      decimalPlaces: getDecimalPlaces(presenceCurrency),
      priceIncrementMinor: marketCurrencyIncrementMinor(presenceCurrency),
      /** The shop currency (what the market selector shows for the other markets). */
      shopCode: currency.value.currencyCode,
    }
    : {
      code: currency.value.currencyCode,
      symbol: currency.value.currencySymbol,
      decimalPlaces: getDecimalPlaces(currency.value.currencyCode),
      // Product pages price SKUs with the rule checkout charges, at the backup market's increment.
      priceIncrementMinor: storeCurrencyOf(currency.value, backupPriceIncrementMinor).priceIncrementMinor,
    };
  // The storefront renders a stored theme whole or the default whole, never a mix.
  const themeRow = (themeResults as Array<{ value?: string; textContext?: unknown }>)[0];
  const publishedTheme = parseStoredStorefrontThemeDocument(themeRow?.value);
  if (themeRow && !publishedTheme) {
    console.warn("[Storefront] Published theme is unreadable; rendering the default theme.");
  }
  const storefrontTheme = publishedTheme ?? DEFAULT_STOREFRONT_THEME;
  const { brand, skinMedia } = brandMedia.resolve(brandMediaRows, themeRow?.value, storefrontTheme.brand);
  // Apps with storefront components (sections, slots, islands, stylesheet).
  const appExtensions = activePluginStorefrontExtensions(activeApps.values());
  // The theme in the page's words: its sections', skins' and bars' text in a
  // presence's language, with the apps' own schemas for their text settings.
  const themeText = translation ? storefrontThemeTextOf(storefrontTheme, parseTranslationContext(themeRow?.textContext)) : null;
  const storeShape = storeShapeFromCounts(
    (storeShapeResults as StoreShapeCountsRow[])[0],
    navigationData,
  );
  const metaCapi = { browserEventsEnabled };
  const tracking = await layoutTracking(rows, ctx, browserEventsEnabled);
  const publicBusiness = {
    companyName: business.value.companyName,
    legalName: business.value.legalName,
    addressLine1: business.value.addressLine1,
    addressLine2: business.value.addressLine2,
    city: business.value.city,
    stateRegion: business.value.stateRegion,
    postalCode: business.value.postalCode,
    country: business.value.country,
    phone: business.value.phone,
    email: business.value.email,
    taxId: business.value.taxId,
    // The store's social profiles: header, footer and mobile menu list these only.
    socialLinks: business.value.socialLinks,
  };

  return {
    analytics: processedAnalytics,
    navigation: navigationData,
    // The header menu is \`navigation\`; the theme's navigation source picks
    // either or both (storefront header nav-tree.ts assembles them).
    categoryTree: trimCategoryNavigation(categoryNavigationFromRows(
      categoryNavigationRows as Parameters<typeof categoryNavigationFromRows>[0],
      undefined,
      translation,
    )),
    footerMenus,
    currency: currencyData,
    markets: marketMatrix,
    theme: translateStorefrontTheme(storefrontTheme, themeText, storefrontExtensionSettingSchemas(appExtensions)),
    /** The published theme's brand images; a preview resolves its draft's own. */
    brand,
    /** Images the published theme's unit skins name (their apps' `image` settings); a preview resolves its draft's own. */
    skinMedia,
    storeShape,
    media: media.value,
    metaCapi,
    tracking,
    business: publicBusiness,
    seo: {
      discovery: seo.value.discovery,
      returnPolicy: seo.value.returnPolicy,
      socialImage: seo.value.socialImage,
    },
    cspAllowedDomains: security.value.cspAllowedDomains,
    storefrontCopy: resolveStorefrontCopy(checkoutLanguageResults as CheckoutCopyRow[], translation?.locale ?? null),
    policies: publicPolicies,
    // Active apps' approved scripts: the storefront loads them on their pages and adds their hosts to the CSP.
    appScripts: activePluginStorefrontScripts(activeApps.values()),
    appExtensions,
    // Ways to buy a line the active apps offer (a subscription): the buy form lists them.
    purchaseOptions: activePluginPurchaseOptions(activeApps.values()),
    // The page groups where an active app draws a checkout or account block:
    // only those pages read their blocks part (none: no read at all).
    // Buyer services apps provide (search, address autocomplete, sign-in): the pages call them only when named.
    appServices: activePluginStorefrontServices(activeApps.values()),
  };
}

/**
 * Product-page copy (buy buttons, offers, buyer inputs and fulfilment facts)
 * from the checkout copy of the page's language (MARKETS-DESIGN D9: the
 * store default language at the root; English preset when none exists), so
 * merchant edits and Bangla stores reach the product page with the layout.
 */
function resolveStorefrontCopy(rows: readonly CheckoutCopyRow[], locale: string | null) {
  const { code, copy } = pickCheckoutCopy(rows, locale);
  return pickProductPageCopy(code, copy);
}
