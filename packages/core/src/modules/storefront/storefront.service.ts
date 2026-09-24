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
} from "@scalius/database/schema";
import { eq, isNull, isNotNull, inArray, and, or, sql } from "drizzle-orm";
import {
  checkoutLanguageBaseCode,
  resolveCheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { nanoid } from "nanoid";
import {
  processAnalyticsScript,
  shouldInjectAnalyticsScript,
  shouldUsePartytown,
} from "../../integrations/analytics";
import { normalizeCloudflareWebAnalyticsConfig } from "../analytics/analytics.validation";
import { resolveCollectionProductsBatch } from "../collections/collections.service";
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
  parseStoredStorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { parseStoredHeroSlides, type HeroSlide } from "@scalius/shared/hero-slider";
import { mediaImageSrcSet } from "@scalius/shared/media-variants";
import { extractKeyFromUrl } from "../../integrations/storage";
import {
  HEADER_LOGO_WIDTH_DEFAULT,
  normalizeHeaderLogoWidth,
} from "@scalius/shared/brand-presentation";
import { getPublicPageBySlug } from "../pages/pages.service";
import type { Database } from "@scalius/database/client";
import { getPublishedNavigationPlacements } from "../navigation/navigation.authority.service";
import { publicCategoryConditions } from "../categories/categories.publication";

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

function normalizeSocialLink(value: unknown): SocialLink {
  const link = asRecord(value);
  const platform = toOptionalString(link.platform);
  return {
    id: toOptionalString(link.id) ?? nanoid(),
    label: toOptionalString(link.label) ?? platform ?? "",
    url: toOptionalString(link.url) ?? "",
    iconUrl: toOptionalString(link.iconUrl) ?? toOptionalString(link.icon),
  };
}

// ── Homepage data ─────────────────────────────────────────────────────────────

/** D1 binds at most 100 parameters per query; hero slide sets are far smaller. */
const HERO_RENDITION_LOOKUP_LIMIT = 90;

/**
 * Hero slides store an image URL, not a media id. A slide saved before its
 * image had renditions keeps pointing at the original upload, and nothing in
 * that URL says renditions now exist, so the storefront could only preload
 * and paint the full-size original. Such slides are pointed at the image's
 * published (largest) rendition, from which the storefront derives its
 * srcset and a phone-sized preload (@scalius/shared/media-variants). The
 * lookup runs only when a slide still uses an original media URL.
 */
export async function withPublishedHeroRenditions(
  db: Database,
  slides: HeroSlide[],
): Promise<HeroSlide[]> {
  const keyByUrl = new Map<string, string>();
  for (const slide of slides) {
    if (keyByUrl.has(slide.url) || mediaImageSrcSet(slide.url)) continue;
    const key = extractKeyFromUrl(slide.url);
    if (key?.startsWith("media/")) keyByUrl.set(slide.url, key);
  }
  const keys = [...new Set(keyByUrl.values())].slice(0, HERO_RENDITION_LOOKUP_LIMIT);
  if (keys.length === 0) return slides;

  const rows = await db
    .select({ objectKey: media.objectKey, variantWidth: media.variantWidth })
    .from(media)
    .where(and(
      inArray(media.objectKey, keys),
      isNotNull(media.variantWidth),
      inArray(media.status, ["ready", "trashed"]),
    ));
  const widthByKey = new Map(rows.map((row) => [row.objectKey, row.variantWidth]));

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
}

/**
 * Fetch and shape all homepage data in two batched D1 round-trips.
 * Returns the final { seo, hero, collections, presentation } object for c.json().
 */
export async function getHomepageData(db: Database) {
  // === BATCH 1: Independent top-level queries ===
  const batchResults = await db.batch([
    // 0. SEO + homepage presentation documents
    selectSettingsDocuments(db, [seoDocument, homepageDocument]),

    // 1. Hero sliders (desktop and mobile)
    db
      .select()
      .from(heroSliders)
      .where(
        and(eq(heroSliders.isActive, true), isNull(heroSliders.deletedAt)),
      ),

    // 2. Active collections (metadata only)
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
  ]);

  const [
    documentRows,
    heroResults,
    collectionResults,
    categoryResults,
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
  const heroSlides = await withPublishedHeroRenditions(db, [
    ...(desktopHero?.images ?? []),
    ...(mobileHero?.images ?? []),
  ]);
  const desktopSlideCount = desktopHero?.images.length ?? 0;
  const hero = {
    desktop: desktopHero && { ...desktopHero, images: heroSlides.slice(0, desktopSlideCount) },
    mobile: mobileHero && { ...mobileHero, images: heroSlides.slice(desktopSlideCount) },
  };

  // === BATCH 2: Products for collections ===
  const parsedCollections = (
    collectionResults as Record<string, unknown>[]
  ).map((col) => ({
    id: col.id as string,
    name: col.name as string,
    presentation: col.presentation as string,
    sortOrder: col.sortOrder as number,
    isActive: col.isActive as boolean,
    parsedConfig: normalizeCollectionConfig(col.config),
  })).filter((collection) => collection.parsedConfig.showOnHomepage);

  const resolvedMap = await resolveCollectionProductsBatch(
    db,
    parsedCollections.map((col) => ({ id: col.id, config: col.parsedConfig as Parameters<typeof resolveCollectionProductsBatch>[1][number]["config"] })),
  );

  // Build final collections array
  const formattedCollections = parsedCollections
    .map((col) => {
      const cfg = col.parsedConfig;
      const resolved = resolvedMap.get(col.id);
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
 * Returns the final { analytics, header, navigation, footer, currency, theme, ..., cspAllowedDomains } object.
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
  ]);

  const [
    analyticsResults,
    documentRows,
    themeResults,
    checkoutLanguageResults,
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
 * Product-page call-to-action copy from the same active checkout language
 * (English preset when none exists), so Bangla stores translate the buttons.
 */
function resolveStorefrontCopy(
  rows: { code: string; languageData: string; isActive: boolean }[],
) {
  const row = rows.find((candidate) => candidate.isActive) ?? rows[0];
  const code = row?.code ?? "en";
  const copy = resolveCheckoutLanguageData(code, row?.languageData);
  return {
    languageCode: checkoutLanguageBaseCode(code),
    addToCartText: copy.addToCartText,
    buyNowText: copy.buyNowText,
    unavailableText: copy.unavailableText,
    chooseOptionText: copy.chooseOptionText,
    fromPriceText: copy.fromPriceText,
    quantityLabelText: copy.quantityLabelText,
    quantityLimitText: copy.quantityLimitText,
    saleOfferText: copy.saleOfferText,
    saleOfferSpendText: copy.saleOfferSpendText,
    saleOfferGetText: copy.saleOfferGetText,
    saleOfferGetSpendText: copy.saleOfferGetSpendText,
    freeBenefitText: copy.freeBenefitText,
    percentBenefitText: copy.percentBenefitText,
  };
}
