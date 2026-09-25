// src/modules/storefront/storefront.service.ts
// Data query and shaping functions for the storefront API.
// Extracted from src/server/routes/storefront.ts — zero logic changes.
//
// These functions perform the heavy batched D1 queries and normalise the data.
// Route handlers simply call a function and return c.json(result).

import {
  collections,
  heroSliders,
  analytics,
  settings,
  themeSettings,
  categories,
  checkoutLanguages,
  media,
  productBuyerState,
  products,
} from "@scalius/database/schema";
import { eq, isNull, inArray, and, or, sql } from "drizzle-orm";
import {
  pickProductPageCopy,
  resolveCheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import {
  processAnalyticsScript,
  shouldInjectAnalyticsScript,
  shouldUsePartytown,
} from "../../integrations/analytics";
import { normalizeCloudflareWebAnalyticsConfig } from "../analytics/analytics.validation";
import { planCollectionProducts } from "../collections/collections.service";
import { planHomeProductLists, type HomeProductList } from "../catalog/home-lists";
import { planHomeMedia } from "./homepage-sections";
import { normalizeCollectionConfig, publicCollectionConfig } from "../collections/collection-config";
import {
  businessDocument,
  currencyDocument,
  footerDocument,
  headerDocument,
  homepageDocument,
  mediaDocument,
  metaConversionsDocument,
  policiesDocument,
  securityDocument,
  seoDocument,
} from "../settings/documents";
import { resolvePublicStorePolicies } from "../settings/store-policies.service";
import {
  selectSettingsDocuments,
  SETTINGS_DOCUMENT_ROW_KEY,
  type SettingsDocumentRow,
} from "../settings/settings-store";
import {
  DEFAULT_STOREFRONT_THEME,
  homeSectionRequests,
  parseStoredStorefrontThemeDocument,
  type HomeSectionRequests,
} from "@scalius/shared/storefront-theme";
import { parseStoredHeroSlides, type HeroSlide } from "@scalius/shared/hero-slider";
import { mediaImageSrcSet } from "@scalius/shared/media-variants";
import { extractKeyFromUrl } from "../../integrations/storage";
import {
  HEADER_LOGO_WIDTH_DEFAULT,
  normalizeHeaderLogoWidth,
} from "@scalius/shared/brand-presentation";
import { getPublicPageBySlug } from "../pages/pages.service";
import { safeBatch, type Database } from "@scalius/database/client";
import { selectStoreShapeCounts, storeShapeFromCounts, type StoreShapeCountsRow } from "./store-shape";
import { getPublishedNavigationPlacements } from "../navigation/navigation.authority.service";
import { publicCategoryConditions } from "../categories/categories.publication";
import { deps } from "../../cache-deps";

// ── Local helpers & interfaces ────────────────────────────────────────────────

interface NestedNavigationItem {
  id?: string;
  title: string;
  href?: string;
  imageUrl?: string;
  openInNewTab?: boolean;
  subMenu?: NestedNavigationItem[];
}

interface SocialLink {
  id: string;
  label: string;
  url: string;
  iconUrl?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function toOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

/**
 * A stable id for a stored social link saved without one: FNV-1a over its
 * position, platform and URL. Public reads must render byte-identical output
 * for identical data (the cache validator and audit compare bodies), so an id
 * is never minted per render.
 */
function fallbackSocialLinkId(index: number, platform: string | undefined, url: string): string {
  let hash = 0x811c9dc5;
  const input = `${index}\u0000${platform ?? ""}\u0000${url}`;
  for (let position = 0; position < input.length; position += 1) {
    hash ^= input.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193);
  }
  return `social_${index}_${(hash >>> 0).toString(36)}`;
}

function normalizeSocialLink(value: unknown, index: number): SocialLink {
  const link = asRecord(value);
  const platform = toOptionalString(link.platform);
  const url = toOptionalString(link.url) ?? "";
  return {
    id: toOptionalString(link.id) ?? fallbackSocialLinkId(index, platform, url),
    label: toOptionalString(link.label) ?? platform ?? "",
    url,
    iconUrl: toOptionalString(link.iconUrl) ?? toOptionalString(link.icon),
  };
}

// ── Homepage data ─────────────────────────────────────────────────────────────

interface HeroRenditionRow {
  id: string;
  objectKey: string;
  variantWidth: number | null;
  status: string;
}

/** D1 binds at most 100 parameters per query; hero slide sets are far smaller. */
const HERO_RENDITION_LOOKUP_LIMIT = 90;

/**
 * Hero slides store an image URL, not a media id. A slide saved before its
 * image had renditions keeps pointing at the original upload, and nothing in
 * that URL says renditions now exist, so the storefront could only preload
 * and paint the full-size original. Such slides are pointed at the image's
 * published (largest) rendition, from which the storefront derives its
 * srcset and a phone-sized preload (@scalius/shared/media-variants). The
 * lookup is planned only when a slide still uses an original media URL, and
 * joins the homepage's second batch.
 */
function planHeroRenditions(db: Database, slides: HeroSlide[]) {
  const keyByUrl = new Map<string, string>();
  for (const slide of slides) {
    if (keyByUrl.has(slide.url) || mediaImageSrcSet(slide.url)) continue;
    const key = extractKeyFromUrl(slide.url);
    if (key?.startsWith("media/")) keyByUrl.set(slide.url, key);
  }
  const keys = [...new Set(keyByUrl.values())].slice(0, HERO_RENDITION_LOOKUP_LIMIT);
  const statement = keys.length === 0 ? null : db
    .select({ id: media.id, objectKey: media.objectKey, variantWidth: media.variantWidth, status: media.status })
    .from(media)
    .where(inArray(media.objectKey, keys));
  return {
    statement,
    apply(rows: HeroRenditionRow[]): HeroSlide[] {
      // Every row found by key, published rendition or not: its m:<id> advances
      // when a rendition is written or its status changes.
      deps.mediaItems(rows.map((row) => row.id));
      const widthByKey = new Map(rows
        .filter((row) => row.variantWidth !== null && (row.status === "ready" || row.status === "trashed"))
        .map((row) => [row.objectKey, row.variantWidth]));
      return slides.map((slide) => {
        const key = keyByUrl.get(slide.url);
        const width = key ? widthByKey.get(key) : null;
        if (!width) return slide;
        try {
          const url = new URL(slide.url);
          url.pathname = `${url.pathname}/${width}.webp`;
          return { ...slide, url: url.toString() };
        } catch {
          return slide;
        }
      });
    },
  };
}

export async function withPublishedHeroRenditions(
  db: Database,
  slides: HeroSlide[],
): Promise<HeroSlide[]> {
  const plan = planHeroRenditions(db, slides);
  return plan.apply(plan.statement ? await plan.statement : []);
}

/** A homepage product list: its products and what it reads from (for titles and "View all"). */
export interface HomepageProductList extends HomeProductList {
  /** A collection list's collection (active collections only). */
  collection: { id: string; title: string } | null;
}

type BatchItem = Parameters<typeof safeBatch>[1][number];

/**
 * A landing homepage's product, only while it is public (the buyer state
 * projection's single-sourced rule); otherwise null, and the homepage is the
 * catalog. Planned only when the homepage document asks for a landing
 * product, so a catalog homepage reads no product row for it.
 */
function planLandingProduct(
  db: Database,
  homepage: { homeMode?: string; landingProductId?: string | null } | null,
) {
  const productId = homepage?.homeMode === "landing" ? homepage.landingProductId?.trim() || null : null;
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
    statement,
    resolve(rows: unknown): { id: string; slug: string } | null {
      return (rows as Array<{ id: string; slug: string }>)[0] ?? null;
    },
  };
}

/**
 * Fetch and shape all homepage data in two batched D1 round trips.
 *
 * 1. Settings documents, hero banners, active collections, the category
 *    rail and, unless the caller names the section reads, the published
 *    theme (whose sections say which product lists and images to read).
 * 2. One batch with every product list (homepage collections, section
 *    sources), each with the card media of exactly its rows, the section
 *    images and the hero rendition lookup.
 *
 * `requests` (a preview's draft sections) replaces the published theme's;
 * with `sectionsOnly` the second batch holds the section reads alone.
 */
export async function getHomepageData(db: Database, options: {
  requests?: HomeSectionRequests;
  /**
   * Only the section lists and images (a theme preview's draft): the
   * published homepage collections and banner renditions are not read.
   */
  sectionsOnly?: boolean;
} = {}) {
  // === BATCH 1: Independent top-level queries ===
  const batchResults = await safeBatch(db, [
    // 0. SEO + homepage presentation documents
    selectSettingsDocuments(db, [seoDocument, homepageDocument]),

    // 1. Hero sliders (desktop and mobile)
    db
      .select()
      .from(heroSliders)
      .where(
        and(eq(heroSliders.isActive, true), isNull(heroSliders.deletedAt)),
      ),

    // 2. Active collections (metadata only): the homepage ones and any a
    // section reads from.
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

    // 3. Public metadata for the exact category IDs saved in the homepage
    // document. Resolve the bounded ID set in SQLite so a selected category
    // cannot disappear merely because a large catalog has more than 100 rows.
    // json_valid() keeps a malformed legacy document fail-closed.
    db
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
        sql`${categories.id} IN (
          SELECT CAST(homepage_category.value AS TEXT)
          FROM ${settings}, json_each(
            CASE
              WHEN json_valid(${settings.value})
                THEN json_extract(${settings.value}, '$.categoryRail.categoryIds')
              ELSE '[]'
            END
          ) AS homepage_category
          WHERE ${settings.category} = ${homepageDocument.key}
            AND ${settings.key} = ${SETTINGS_DOCUMENT_ROW_KEY}
        )`,
      )),

    // 4. The published theme: its sections name the lists and images to read.
    db
      .select({ value: themeSettings.colors })
      .from(themeSettings)
      .where(eq(themeSettings.id, "default"))
      .limit(1),
  ]);
  deps.hero();
  deps.anyCollection();
  deps.theme();

  const [
    documentRows,
    heroResults,
    collectionResults,
    categoryResults,
    themeResults,
  ] =
    batchResults;

  const rows = documentRows as SettingsDocumentRow[];
  const [seo, homepage] = await Promise.all([
    seoDocument.fromRows(rows),
    homepageDocument.fromRows(rows),
  ]);
  // Unset copy stays null: the storefront titles the homepage with the
  // store name instead of inventing a platform-branded headline.
  const seoSettings = {
    homepageTitle: seo.value.homepageTitle.trim() || null,
    homepageMetaDescription: seo.value.homepageMetaDescription.trim() || null,
  };
  const homepageConfig = homepage.value;
  // The rail shows the saved ids that are public categories now; any of them
  // may be published, renamed or trashed later.
  deps.categories(homepageConfig.categoryRail.categoryIds);
  // An unreadable theme renders the default whole (as the layout read does).
  const requests = options.requests ?? homeSectionRequests(
    (parseStoredStorefrontThemeDocument((themeResults as { value?: string }[])[0]?.value)
      ?? DEFAULT_STOREFRONT_THEME).pages.home,
  );

  // Process Hero
  const desktopSlider = (heroResults as { type: string }[]).find(
    (s) => s.type === "desktop",
  );
  const mobileSlider = (heroResults as { type: string }[]).find(
    (s) => s.type === "mobile",
  );
  const formatSlider = (slider: Record<string, unknown> | undefined) => {
    if (!slider) return null;
    return {
      id: slider.id,
      type: slider.type,
      images: parseStoredHeroSlides(slider.images),
    };
  };
  const desktopHero = formatSlider(desktopSlider);
  const mobileHero = formatSlider(mobileSlider);
  const heroRenditions = planHeroRenditions(db, options.sectionsOnly ? [] : [
    ...(desktopHero?.images ?? []),
    ...(mobileHero?.images ?? []),
  ]);

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
  const parsedCollections = options.sectionsOnly
    ? []
    : activeCollections.filter((collection) => collection.parsedConfig.showOnHomepage);
  const collectionById = new Map(activeCollections.map((collection) => [collection.id, collection]));
  const collectionLists = requests.lists.flatMap((list) => {
    const collection = list.source.kind === "collection" ? collectionById.get(list.source.collectionId) : undefined;
    return collection ? [{ list, collection }] : [];
  });
  const collectionPlan = planCollectionProducts(db, [
    ...parsedCollections.map((col) => ({ key: `homepage:${col.id}`, config: col.parsedConfig })),
    ...collectionLists.map(({ list, collection }) => ({ key: list.key, config: collection.parsedConfig, maxProducts: list.limit })),
  ]);
  const listPlan = planHomeProductLists(db, requests.lists.filter((list) => list.source.kind !== "collection"));
  const mediaPlan = planHomeMedia(db, requests.mediaIds);
  const landingPlan = planLandingProduct(db, options.sectionsOnly ? null : homepageConfig);
  const statements: BatchItem[] = [
    ...collectionPlan.statements,
    ...listPlan.statements,
    ...mediaPlan.statements,
    ...(heroRenditions.statement ? [heroRenditions.statement] : []),
    ...(landingPlan.statement ? [landingPlan.statement] : []),
  ];
  const results = statements.length > 0 ? await safeBatch(db, statements) : [];
  const listOffset = collectionPlan.statements.length;
  const mediaOffset = listOffset + listPlan.statements.length;
  const resolvedMap = collectionPlan.resolve(results);
  const productLists = listPlan.resolve(results, listOffset);
  const heroSlides = heroRenditions.apply(heroRenditions.statement
    ? results[mediaOffset + mediaPlan.statements.length] as HeroRenditionRow[]
    : []);
  const landingProduct = landingPlan.resolve(landingPlan.statement
    ? results[mediaOffset + mediaPlan.statements.length + (heroRenditions.statement ? 1 : 0)]
    : []);
  const desktopSlideCount = desktopHero?.images.length ?? 0;
  const hero = {
    desktop: desktopHero && { ...desktopHero, images: heroSlides.slice(0, desktopSlideCount) },
    mobile: mobileHero && { ...mobileHero, images: heroSlides.slice(desktopSlideCount) },
  };

  // Build final collections array
  const formattedCollections = parsedCollections
    .map((col) => {
      const cfg = col.parsedConfig;
      const resolved = resolvedMap.get(`homepage:${col.id}`);
      if (!resolved || resolved.products.length === 0) return null;

      return {
        id: col.id,
        name: col.name,
        presentation: col.presentation,
        config: publicCollectionConfig(cfg),
        sortOrder: col.sortOrder,
        isActive: col.isActive,
        categories: resolved.categories,
        products: resolved.products,
        featuredProduct: resolved.featuredProduct,
      };
    })
    .filter(Boolean);

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

  const categoryById = new Map(
    (categoryResults as Array<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      imageUrl: string | null;
      canonicalPath: string | null;
    }>).map((category) => [category.id, category]),
  );
  const homepageCategories = homepageConfig.categoryRail.categoryIds
    .map((id) => categoryById.get(id))
    .filter((category): category is NonNullable<typeof category> => Boolean(category));

  return {
    seo: seoSettings,
    hero,
    collections: formattedCollections,
    presentation: {
      categoryRail: {
        enabled: homepageConfig.categoryRail.enabled && homepageCategories.length > 0,
        title: homepageConfig.categoryRail.title,
        categories: homepageCategories,
      },
      // The storefront states delivery, cash-on-delivery and return facts
      // from the live shipping, checkout and return-policy data it already
      // reads for product pages (apps/storefront/src/lib/delivery-facts.ts).
      trustStrip: {
        enabled: homepageConfig.trustStrip.enabled,
      },
      // "landing" only while its product is public; the storefront then
      // opens on that product's landing page.
      homeMode: landingProduct ? "landing" as const : "catalog" as const,
      landingProduct,
    },
    sections: {
      lists,
      media: mediaPlan.resolve(results, mediaOffset),
    },
  };
}

// ── CMS page render data ────────────────────────────────────────────────────

export async function getPageRenderData(db: Database, slug: string) {
  const page = await getPublicPageBySlug(db, slug);
  if (!page) return null;

  return { page };
}

// ── Layout data ───────────────────────────────────────────────────────────────

const LAYOUT_DOCUMENTS = [
  headerDocument,
  footerDocument,
  currencyDocument,
  mediaDocument,
  metaConversionsDocument,
  seoDocument,
  businessDocument,
  securityDocument,
  policiesDocument,
];

/**
 * Fetch and shape all layout data in a single batched D1 round-trip.
 * Returns the final { analytics, header, navigation, footer, currency, theme, storeShape, ..., cspAllowedDomains } object.
 */
export async function getLayoutData(
  db: Database,
  options: { credentialEncryptionKey?: string } = {},
) {
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

    // 4. Store shape counts for the theme fit rules (bounded, one statement)
    selectStoreShapeCounts(db),
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
  ] = batchResults;
  const rows = documentRows as SettingsDocumentRow[];
  const ctx = { encryptionKey: options.credentialEncryptionKey };
  const [header, footer, currency, media, metaCapiSettings, seo, business, security, policies] = await Promise.all([
    headerDocument.fromRows(rows, ctx),
    footerDocument.fromRows(rows, ctx),
    currencyDocument.fromRows(rows, ctx),
    mediaDocument.fromRows(rows, ctx),
    metaConversionsDocument.fromRows(rows, ctx),
    seoDocument.fromRows(rows, ctx),
    businessDocument.fromRows(rows, ctx),
    securityDocument.fromRows(rows, ctx),
    policiesDocument.fromRows(rows, ctx),
  ]);
  // Only linked policies whose pages are published; nothing to read when none are linked.
  const publicPolicies = await resolvePublicStorePolicies(db, policies.value);
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
  let navigationPlacements: Awaited<ReturnType<typeof getPublishedNavigationPlacements>> = [];
  try {
    navigationPlacements = await getPublishedNavigationPlacements(db);
  } catch {
    // Navigation is independently versioned presentation. A corrupt placement
    // must not take down checkout, account, or the rest of the storefront.
    console.warn("[Storefront] Published navigation could not be loaded.");
  }
  const headerPlacement = navigationPlacements.find((placement) => (
    placement.surface === "header" && placement.slot === "primary"
  ));
  const footerPlacements = navigationPlacements.filter((placement) => (
    placement.surface === "footer" && placement.slot === "column"
  ));
  const normalizedFooterMenus = footerPlacements.map((placement) => ({
    id: placement.id,
    title: placement.labelOverride || placement.menuName,
    links: placement.items,
  }));
  let headerData: Record<string, unknown>;
  const navigationData = (headerPlacement?.items ?? []) as NestedNavigationItem[];

  if (header.stored) {
    const headerConfig = header.value;
    const topBarConfig = asRecord(headerConfig.topBar);
    const logoConfig = asRecord(headerConfig.logo);
    const faviconConfig = asRecord(headerConfig.favicon);
    const contactConfig = asRecord(headerConfig.contact);

    // Normalize social links — supports both array and legacy { facebook: "url" } format
    let socialLinks: SocialLink[] = [];
    if (Array.isArray(headerConfig.social)) {
      socialLinks = headerConfig.social.map(normalizeSocialLink);
    } else if (headerConfig.social && typeof headerConfig.social === "object") {
      Object.entries(headerConfig.social).forEach(([platform, url]) => {
        if (url && typeof url === "string") {
          socialLinks.push({
            id: platform,
            label: platform.charAt(0).toUpperCase() + platform.slice(1),
            url,
          });
        }
      });
    }

    headerData = {
      topBar: {
        text: topBarConfig.text || "",
        isEnabled: topBarConfig.isEnabled ?? true,
      },
      logo: {
        src: logoConfig.src || "",
        alt: logoConfig.alt || "",
        width: normalizeHeaderLogoWidth(logoConfig.width),
      },
      favicon: {
        src: faviconConfig.src || "/favicon.svg",
        alt: faviconConfig.alt || "",
      },
      contact: {
        phone: contactConfig.phone || "",
        text: contactConfig.text || "",
        isEnabled: contactConfig.isEnabled ?? true,
      },
      social: socialLinks,
    };

  } else {
    headerData = {
      topBar: { text: "", isEnabled: false },
      logo: { src: "", alt: "", width: HEADER_LOGO_WIDTH_DEFAULT },
      favicon: { src: "/favicon.svg", alt: "" },
      contact: { phone: "", text: "", isEnabled: false },
      social: [],
    };
  }

  // Process Footer
  let footerData: Record<string, unknown>;
  if (footer.stored) {
    const footerConfig = footer.value;
    const footerLogoConfig = asRecord(footerConfig.logo);
    const footerFaviconConfig = asRecord(footerConfig.favicon);

    let footerSocialLinks: SocialLink[] = [];
    if (Array.isArray(footerConfig.social)) {
      footerSocialLinks = footerConfig.social.map(normalizeSocialLink);
    }

    footerData = {
      logo: {
        src: footerLogoConfig.src || "",
        alt: footerLogoConfig.alt || "",
      },
      favicon: {
        src: footerFaviconConfig.src || "/favicon.svg",
        alt: footerFaviconConfig.alt || "",
      },
      tagline: footerConfig.tagline || "",
      description: footerConfig.description || "",
      copyrightText: footerConfig.copyrightText || "",
      menus: normalizedFooterMenus,
      social: footerSocialLinks,
    };
  } else {
    footerData = {
      logo: { src: "", alt: "" },
      favicon: { src: "/favicon.svg", alt: "" },
      tagline: "",
      description: "",
      copyrightText: "",
      menus: normalizedFooterMenus,
      social: [],
    };
  }

  const currencyRate = Number(currency.value.usdExchangeRate);
  const currencyData = {
    code: currency.value.currencyCode,
    symbol: currency.value.currencySymbol,
    usdExchangeRate: Number.isFinite(currencyRate) && currencyRate > 0 ? currencyRate : 1,
  };
  // The storefront renders a stored theme whole or the default whole, never a mix.
  const themeRow = (themeResults as { value?: string }[])[0];
  const publishedTheme = parseStoredStorefrontThemeDocument(themeRow?.value);
  if (themeRow && !publishedTheme) {
    console.warn("[Storefront] Published theme is unreadable; rendering the default theme.");
  }
  const storefrontTheme = publishedTheme ?? DEFAULT_STOREFRONT_THEME;
  const storeShape = storeShapeFromCounts(
    (storeShapeResults as StoreShapeCountsRow[])[0],
    navigationData,
  );
  const metaCapi = {
    browserEventsEnabled: Boolean(
      metaCapiSettings.value.isEnabled &&
      metaCapiSettings.value.pixelId.trim() &&
      metaCapiSettings.value.accessToken.trim(),
    ),
  };
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
  };

  return {
    analytics: processedAnalytics,
    header: headerData,
    navigation: navigationData,
    footer: footerData,
    currency: currencyData,
    theme: storefrontTheme,
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
