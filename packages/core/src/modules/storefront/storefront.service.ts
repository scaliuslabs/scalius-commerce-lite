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
  checkoutLanguages,
  productBuyerState,
  products,
} from "@scalius/database/schema";
import { eq, isNull, and, or, sql } from "drizzle-orm";
import {
  pickProductPageCopy,
  resolveCheckoutLanguageData,
} from "@scalius/shared/checkout-language";
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
} from "../catalog";
import { planHomeMedia, planHomePromotions, planPublishedThemeBrandMedia } from "./homepage-sections";
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
import {
  selectSettingsDocuments,
  type SettingsDocumentRow,
} from "../../settings-store";
import {
  DEFAULT_STOREFRONT_THEME,
  homeSectionRequests,
  parseStoredStorefrontThemeDocument,
  type HomeAppSectionRequest,
  type HomeSectionRequests,
} from "@scalius/shared/storefront-theme";
import { getDecimalPlaces } from "@scalius/shared/currency";
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
  activePluginStorefrontScripts,
  selectActivePluginInstallations,
} from "../plugins";
import type { PluginInstallationRow } from "@scalius/database/schema";
import { PLUGIN_RENDER_RETRY_SECONDS } from "@scalius/shared/plugins";
import { deps } from "../../cache-deps";
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
function planHomeCategories(db: Database, ids: readonly string[]) {
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
    })
    .from(categories)
    .where(and(
      ...publicCategoryConditions(),
      sql`${categories.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`,
    ));
  return {
    statements: [statement] as BatchItem[],
    resolve(results: readonly unknown[], offset: number): HomepageCategory[] {
      const byId = new Map((results[offset] as HomepageCategory[]).map((row) => [row.id, row]));
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
function planHomeProduct(db: Database, productId: string | null) {
  deps.product(productId);
  const statement = productId === null ? null : db
    .select({ id: products.id, slug: products.slug })
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
      return statement ? (results[offset] as Array<{ id: string; slug: string }>)[0] ?? null : null;
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
/** One app section drawn by its app (apps/api plugins/storefront-render.ts). */
export interface HomepageAppSection {
  sectionId: string;
  html: string;
  head: { meta: Array<{ attribute: "name" | "property"; key: string; content: string }>; jsonLd: string[] };
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
     * Draws the page's app sections (the API's plugin host); runs beside the
     * second batch, so a homepage with app sections adds no wave before its
     * apps' own reads. Without it, app sections draw nothing.
     */
    renderApps?: (requests: HomeAppSectionRequest[]) => Promise<HomepageAppSection[]>;
  } = {},
) {
  // === BATCH 1: Independent top-level queries ===
  const batchResults = await safeBatch(db, [
    // 0. SEO document (homepage title and description)
    ...(options.pageSlug ? [] : [selectSettingsDocuments(db, [seoDocument])]),

    // 1. Active collections (metadata only): the ones the sections name.
    db
      .select({
        id: collections.id,
        name: collections.name,
        presentation: collections.presentation,
        config: collections.config,
        sortOrder: collections.sortOrder,
        isActive: collections.isActive,
      })
      .from(collections)
      .where(and(eq(collections.isActive, true), isNull(collections.deletedAt)))
      .orderBy(collections.sortOrder),

    // 2. The published theme: its sections and home mode name the reads.
    db
      .select({ value: themeSettings.colors })
      .from(themeSettings)
      .where(eq(themeSettings.id, "default"))
      .limit(1),
  ]);
  deps.theme();

  const collectionResults = batchResults[batchResults.length - 2];
  const themeResults = batchResults[batchResults.length - 1];
  const seo = options.pageSlug ? null : await seoDocument.fromRows(batchResults[0] as SettingsDocumentRow[]);
  // Unset copy stays null: the storefront titles the homepage with the
  // store name instead of inventing a platform-branded headline.
  const seoSettings = {
    homepageTitle: seo?.value.homepageTitle.trim() || null,
    homepageMetaDescription: seo?.value.homepageMetaDescription.trim() || null,
  };
  // An unreadable theme renders the default whole (as the layout read does).
  const theme = parseStoredStorefrontThemeDocument((themeResults as { value?: string }[])[0]?.value)
    ?? DEFAULT_STOREFRONT_THEME;
  const landing = options.pageSlug ? theme.pages.landing[options.pageSlug] ?? null : null;
  const requests = options.requests ?? (options.pageSlug
    ? homeSectionRequests(landing?.sections ?? [], { kind: "sections" })
    : homeSectionRequests(theme.pages.home, theme.pages.homeMode));
  // A landing page depends on the collections its sections name; the homepage on any.
  if (options.pageSlug) deps.collections([
    ...requests.collectionIds,
    ...requests.lists.flatMap((list) => list.source.kind === "collection" ? [list.source.collectionId] : []),
  ]);
  else deps.anyCollection();
  // The apps draw their sections while batch 2 reads the platform sections' data.
  const appSections: Promise<HomepageAppSection[]> = (requests.apps ?? []).length > 0 && options.renderApps
    ? options.renderApps(requests.apps ?? []).catch((error: unknown) => {
      console.warn(`[Storefront] App sections could not be drawn (${error instanceof Error ? error.name : "error"}).`);
      // Draw the page without them, and try them again soon.
      deps.validUntil(Date.now() + PLUGIN_RENDER_RETRY_SECONDS * 1000);
      return [];
    })
    : Promise.resolve([]);

  // === BATCH 2: every product list, its card media, section images ===
  const activeCollections = (
    collectionResults as Record<string, unknown>[]
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
  ]);
  const listPlan = planHomeProductLists(db, requests.lists.filter((list) => list.source.kind !== "collection"));
  const mediaPlan = planHomeMedia(db, requests.mediaIds);
  const brandPlan = planHomeBrands(db, requests.brandLimit);
  const promotionPlan = planHomePromotions(db, requests.promotionIds);
  const categoryPlan = planHomeCategories(db, requests.categoryIds);
  const productPlan = planHomeProduct(db, requests.homeProductId);
  const statements: BatchItem[] = [
    ...collectionPlan.statements,
    ...listPlan.statements,
    ...mediaPlan.statements,
    ...brandPlan.statements,
    ...promotionPlan.statements,
    ...categoryPlan.statements,
    ...productPlan.statements,
  ];
  const results = statements.length > 0 ? await safeBatch(db, statements) : [];
  const listOffset = collectionPlan.statements.length;
  const mediaOffset = listOffset + listPlan.statements.length;
  const brandOffset = mediaOffset + mediaPlan.statements.length;
  const promotionOffset = brandOffset + brandPlan.statements.length;
  const categoryOffset = promotionOffset + promotionPlan.statements.length;
  const productOffset = categoryOffset + categoryPlan.statements.length;
  const resolvedMap = collectionPlan.resolve(results);
  const productLists = listPlan.resolve(results, listOffset);

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

  return {
    seo: seoSettings,
    ...(options.pageSlug ? { landing } : {}),
    sections: {
      lists,
      media: mediaPlan.resolve(results, mediaOffset),
      brands: brandPlan.resolve(results, brandOffset),
      promotions: promotionPlan.resolve(results, promotionOffset),
      categories: categoryPlan.resolve(results, categoryOffset),
      collections: formattedCollections,
      // Only while the product is public; the storefront then answers `/`
      // with a redirect to the product's own page.
      homeProduct: productPlan.resolve(results, productOffset),
      // App sections that drew something, by section id (sanitized HTML).
      apps: await appSections,
    },
  };
}

// ── Landing page render data ────────────────────────────────────────────────

/** A published landing page and its sections' data; null when the live theme has no page at that slug. */
export async function getLandingPageData(
  db: Database,
  slug: string,
  options: Pick<NonNullable<Parameters<typeof getHomepageData>[1]>, "renderApps"> = {},
) {
  const data = await getHomepageData(db, { ...options, pageSlug: slug });
  return data.landing ? { landing: data.landing, sections: data.sections } : null;
}

// ── CMS page render data ────────────────────────────────────────────────────

export async function getPageRenderData(db: Database, slug: string) {
  const page = await getPublicPageBySlug(db, slug);
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
];

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
  options: { credentialEncryptionKey?: string } = {},
) {
  const brandMedia = planPublishedThemeBrandMedia(db);
  const navigationPlan = planPublishedNavigationPlacements(db);
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

    // 2. Published theme
    db
      .select({ value: themeSettings.colors })
      .from(themeSettings)
      .where(eq(themeSettings.id, "default"))
      .limit(1),

    // 3. Active (else default) checkout language for storefront buyer copy
    db
      .select({
        code: checkoutLanguages.code,
        languageData: checkoutLanguages.languageData,
        isActive: checkoutLanguages.isActive,
      })
      .from(checkoutLanguages)
      .where(
        and(
          or(eq(checkoutLanguages.isActive, true), eq(checkoutLanguages.isDefault, true)),
          isNull(checkoutLanguages.deletedAt),
        ),
      )
      .limit(2),

    // 4. Store shape counts for the theme fit rules (bounded, one statement),
    // and in the same row the active market matrix with the backup market's
    // price increment (MARKETS-DESIGN D4)
    selectStoreShapeCounts(db, { marketMatrix: marketMatrixSql() }),

    // 5. The reachable category tree: automatic departments and /categories (bounded)
    selectCategoryNavigationRows(db),

    // 6. The published theme's brand images (logo, footer logo, tab icon)
    brandMedia.statement,

    // 7. Active apps (their approved storefront scripts)
    selectActivePluginInstallations(db),

    // 8-9. The placement manifest and the placed menus' published items
    ...navigationPlan.statements,
  ]);

  deps.analytics();
  deps.theme();
  deps.checkoutLanguages();
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
  const policyPlan = planPublicStorePolicies(db, policies.value);
  const resourcePlan = planNavigationResourceSnapshots(db, placedNavigation?.targets ?? []);
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
  const currencyData = {
    code: currency.value.currencyCode,
    symbol: currency.value.currencySymbol,
    decimalPlaces: getDecimalPlaces(currency.value.currencyCode),
    // Product pages price SKUs with the rule checkout charges, at the backup market's increment.
    priceIncrementMinor: storeCurrencyOf(currency.value, backupPriceIncrementMinor).priceIncrementMinor,
  };
  // The storefront renders a stored theme whole or the default whole, never a mix.
  const themeRow = (themeResults as { value?: string }[])[0];
  const publishedTheme = parseStoredStorefrontThemeDocument(themeRow?.value);
  if (themeRow && !publishedTheme) {
    console.warn("[Storefront] Published theme is unreadable; rendering the default theme.");
  }
  const storefrontTheme = publishedTheme ?? DEFAULT_STOREFRONT_THEME;
  const brand = brandMedia.resolve(brandMediaRows, themeRow?.value, storefrontTheme.brand);
  const storeShape = storeShapeFromCounts(
    (storeShapeResults as StoreShapeCountsRow[])[0],
    navigationData,
  );
  const metaCapi = { browserEventsEnabled };
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
    categoryTree: trimCategoryNavigation(categoryNavigationFromRows(categoryNavigationRows)),
    footerMenus,
    currency: currencyData,
    markets: marketMatrix,
    theme: storefrontTheme,
    /** The published theme's brand images; a preview resolves its draft's own. */
    brand,
    storeShape,
    media: media.value,
    metaCapi,
    business: publicBusiness,
    seo: {
      discovery: seo.value.discovery,
      returnPolicy: seo.value.returnPolicy,
      socialImage: seo.value.socialImage,
    },
    cspAllowedDomains: security.value.cspAllowedDomains,
    storefrontCopy: resolveStorefrontCopy(checkoutLanguageResults),
    policies: publicPolicies,
    // Active apps' approved scripts: the storefront loads them on their pages and adds their hosts to the CSP.
    appScripts: activePluginStorefrontScripts(
      activePluginInstallationsFromRows(activePluginRows as PluginInstallationRow[]).values(),
    ),
  };
}

/**
 * Product-page copy (buy buttons, offers, buyer inputs and fulfilment facts)
 * from the same active checkout language (English preset when none exists),
 * so merchant edits and Bangla stores reach the product page with the layout.
 */
function resolveStorefrontCopy(
  rows: { code: string; languageData: string; isActive: boolean }[],
) {
  const row = rows.find((candidate) => candidate.isActive) ?? rows[0];
  const code = row?.code ?? "en";
  return pickProductPageCopy(code, resolveCheckoutLanguageData(code, row?.languageData));
}
