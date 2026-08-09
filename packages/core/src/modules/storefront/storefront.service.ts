// src/modules/storefront/storefront.service.ts
// Data query and shaping functions for the storefront API.
// Extracted from src/server/routes/storefront.ts — zero logic changes.
//
// These functions perform the heavy batched D1 queries and normalise the data.
// Route handlers simply call a function and return c.json(result).

import {
  siteSettings,
  collections,
  heroSliders,
  analytics,
  metaConversionsSettings,
  settings,
  themeSettings,
  categories,
  shippingMethods,
} from "@scalius/database/schema";
import { eq, isNull, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  processAnalyticsScript,
  shouldInjectAnalyticsScript,
  shouldUsePartytown,
} from "../../integrations/analytics";
import { normalizeCloudflareWebAnalyticsConfig } from "../analytics/analytics.validation";
import { readStoredCredentialStrict } from "../../utils/credential-encryption";
import { resolveCollectionProductsBatch } from "../collections/collections.service";
import { normalizeCollectionConfig, publicCollectionConfig } from "../collections/collection-config";
import {
  parseMediaOptimizationSettings,
  readPersistedSitePresentation,
} from "../settings/site-settings.service";
import { parseSeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { parseSeoReturnPolicySettings } from "@scalius/shared/seo-return-policy";
import {
  parseStorefrontThemeSettings,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";
import { parseStoredHeroSlides } from "@scalius/shared/hero-slider";
import { parseHomepagePresentationConfig } from "@scalius/shared/homepage-presentation";
import {
  HEADER_LOGO_WIDTH_DEFAULT,
  normalizeHeaderLogoWidth,
} from "@scalius/shared/brand-presentation";
import {
  DEFAULT_CURRENCY,
  normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import { getPublicPageBySlug } from "../pages/pages.service";
import type { Database } from "@scalius/database/client";
import { getPublishedNavigationPlacements } from "../navigation/navigation.authority.service";
import { publicCategoryConditions } from "../categories/categories.publication";

// ── Local helpers & interfaces ────────────────────────────────────────────────

export function readStorefrontPresentationConfigs(
  headerValue: string | null | undefined,
  footerValue: string | null | undefined,
): {
  headerConfig: Record<string, unknown>;
  footerConfig: Record<string, unknown>;
} {
  return {
    headerConfig: readPersistedSitePresentation("header", headerValue),
    footerConfig: readPersistedSitePresentation("footer", footerValue),
  };
}

export function resolveStorefrontThemeSettings(
  versionedValue: string | null | undefined,
  legacyValue: string | null | undefined,
): StorefrontThemeSettings {
  const value = versionedValue ?? legacyValue;
  return parseStorefrontThemeSettings(value);
}

interface NestedNavigationItem {
  id?: string;
  title: string;
  href?: string;
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

/**
 * Fetch and shape all homepage data in two batched D1 round-trips.
 * Returns the final { seo, hero, collections, presentation } object for c.json().
 */
export async function getHomepageData(db: Database) {
  // === BATCH 1: Independent top-level queries ===
  const batchResults = await db.batch([
    // 0. SEO settings
    db
      .select({
        siteTitle: siteSettings.siteTitle,
        homepageTitle: siteSettings.homepageTitle,
        homepageMetaDescription: siteSettings.homepageMetaDescription,
        homepageConfig: siteSettings.homepageConfig,
      })
      .from(siteSettings)
      .limit(1),

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
          FROM ${siteSettings}, json_each(
            CASE
              WHEN json_valid(${siteSettings.homepageConfig})
                THEN json_extract(${siteSettings.homepageConfig}, '$.categoryRail.categoryIds')
              ELSE '[]'
            END
          ) AS homepage_category
        )`,
      )),

    // 4. One active method is enough to prove delivery is offered.
    db
      .select({ id: shippingMethods.id })
      .from(shippingMethods)
      .where(eq(shippingMethods.isActive, true))
      .limit(1),

    // 5. Return-policy facts used by the truthful policy strip.
    db
      .select({ value: settings.value })
      .from(settings)
      .where(and(
        eq(settings.category, "seo"),
        eq(settings.key, "return_policy"),
      ))
      .limit(1),
  ]);

  const [
    seoResults,
    heroResults,
    collectionResults,
    categoryResults,
    shippingMethodResults,
    returnPolicyResults,
  ] =
    batchResults;

  // Process SEO
  const siteRow = (seoResults as Record<string, unknown>[])[0];
  const seoSettings = siteRow ? {
    siteTitle: siteRow.siteTitle,
    homepageTitle: siteRow.homepageTitle,
    homepageMetaDescription: siteRow.homepageMetaDescription,
  } : {
    siteTitle: "Scalius Commerce",
    homepageTitle: "Welcome to Scalius Commerce",
    homepageMetaDescription: "Your one-stop shop for everything amazing.",
  };
  const homepageConfig = parseHomepagePresentationConfig(
    typeof siteRow?.homepageConfig === "string" ? siteRow.homepageConfig : null,
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
  const hero = {
    desktop: formatSlider(desktopSlider),
    mobile: formatSlider(mobileSlider),
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

  const trustItems: Array<{
    kind: "delivery" | "returns";
    title: string;
    detail: string;
    href?: string;
  }> = [];
  if ((shippingMethodResults as Array<{ id: string }>).length > 0) {
    trustItems.push({
      kind: "delivery",
      title: "Delivery options",
      detail: "Choose an available method at checkout.",
    });
  }
  const returnPolicy = parseSeoReturnPolicySettings(
    (returnPolicyResults as Array<{ value?: string }>)[0]?.value,
  );
  if (returnPolicy.enabled) {
    const returnTitle = returnPolicy.category === "finite"
      ? `${returnPolicy.returnWindowDays}-day returns`
      : returnPolicy.category === "unlimited"
        ? "Open-ended returns"
        : "Final sale policy";
    const returnDetail = returnPolicy.category === "no_returns"
      ? "Review the policy before ordering."
      : returnPolicy.returnFees === "free"
        ? "Return shipping is covered."
        : "Return shipping may apply.";
    trustItems.push({
      kind: "returns",
      title: returnTitle,
      detail: returnDetail,
      ...(returnPolicy.policyUrl ? { href: returnPolicy.policyUrl } : {}),
    });
  }

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
      trustStrip: {
        enabled: homepageConfig.trustStrip.enabled && trustItems.length > 0,
        items: trustItems,
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

/**
 * Fetch and shape all layout data in a single batched D1 round-trip.
 * Returns the final { analytics, header, navigation, footer, currency, theme } object.
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

    // 1. Site settings (header + footer config)
    db
      .select({
        headerConfig: siteSettings.headerConfig,
        footerConfig: siteSettings.footerConfig,
      })
      .from(siteSettings)
      .limit(1),

    // 2. Currency settings
    db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.category, "currency")),

    // 3. Versioned theme color overrides
    db
      .select({ value: themeSettings.colors })
      .from(themeSettings)
      .where(eq(themeSettings.id, "default"))
      .limit(1),

    // 4. Legacy theme color fallback (used only when no versioned row exists)
    db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.category, "theme"),
          eq(settings.key, "storefront_colors"),
        ),
      )
      .limit(1),

    // 5. Media/image optimization settings
    db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.category, "media"),
          eq(settings.key, "image_optimization"),
        ),
      )
      .limit(1),

    // 6. Meta CAPI browser dispatch readiness
    db
      .select({
        isEnabled: metaConversionsSettings.isEnabled,
        pixelId: metaConversionsSettings.pixelId,
        accessToken: metaConversionsSettings.accessToken,
      })
      .from(metaConversionsSettings)
      .where(eq(metaConversionsSettings.id, "singleton"))
      .limit(1),

    // 7. SEO discovery policy
    db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.category, "seo"), eq(settings.key, "discovery")))
      .limit(1),

    // 8. Business identity for public OnlineStore JSON-LD
    db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.category, "business_info")),

    // 9. Merchant return-policy schema settings
    db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.category, "seo"),
          eq(settings.key, "return_policy"),
        ),
      )
      .limit(1),
  ]);

  const [
    analyticsResults,
    settingsResults,
    currencyResults,
    themeResults,
    legacyThemeResults,
    mediaResults,
    metaCapiResults,
    seoDiscoveryResults,
    businessResults,
    seoReturnPolicyResults,
  ] = batchResults;
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
  const siteSettingsData = (settingsResults as Record<string, unknown>[])[0] as
    | Record<string, string | null>
    | undefined;
  const {
    headerConfig: storedHeaderConfig,
    footerConfig: storedFooterConfig,
  } = readStorefrontPresentationConfigs(
    siteSettingsData?.headerConfig,
    siteSettingsData?.footerConfig,
  );
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

  if (siteSettingsData?.headerConfig) {
    const headerConfig = storedHeaderConfig;
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
  if (siteSettingsData?.footerConfig) {
    const footerConfig = storedFooterConfig;
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

  // Process Currency
  const currencyMap = Object.fromEntries(
    (currencyResults as { key: string; value: string }[]).map((r) => [
      r.key,
      r.value,
    ]),
  );
  const currencyCode = normalizeSupportedCurrencyCode(currencyMap.currency_code);
  const parsedExchangeRate = Number(currencyMap.usd_exchange_rate);
  const currencyData = currencyCode
    ? {
        code: currencyCode,
        symbol: currencyMap.currency_symbol ?? DEFAULT_CURRENCY.symbol,
        usdExchangeRate: Number.isFinite(parsedExchangeRate) && parsedExchangeRate > 0
          ? parsedExchangeRate
          : DEFAULT_CURRENCY.usdExchangeRate,
      }
    : {
        code: DEFAULT_CURRENCY.code,
        symbol: DEFAULT_CURRENCY.symbol,
        usdExchangeRate: DEFAULT_CURRENCY.usdExchangeRate,
      };

  // Process Theme
  const storefrontTheme = resolveStorefrontThemeSettings(
    (themeResults as { value?: string }[])[0]?.value,
    (legacyThemeResults as { value?: string }[])[0]?.value,
  );

  const mediaRow = (mediaResults as { value?: string }[])[0];
  const media = parseMediaOptimizationSettings(mediaRow?.value);
  const metaCapiRow = (metaCapiResults as {
    isEnabled?: boolean | null;
    pixelId?: string | null;
    accessToken?: string | null;
  }[])[0];
  const metaCapiAccessToken = await readStoredCredentialStrict(
    metaCapiRow?.accessToken,
    options.credentialEncryptionKey,
    "Meta Conversions API access token",
  );
  if (metaCapiAccessToken.error) {
    console.warn(
      "[Storefront] Meta CAPI browser events are not ready:",
      metaCapiAccessToken.error,
    );
  }
  const metaCapi = {
    browserEventsEnabled: Boolean(
      metaCapiRow?.isEnabled &&
      metaCapiRow.pixelId?.trim() &&
      metaCapiAccessToken.value.trim(),
    ),
  };
  const seoDiscoveryRow = (seoDiscoveryResults as { value?: string }[])[0];
  const discovery = parseSeoDiscoverySettings(seoDiscoveryRow?.value);
  const seoReturnPolicyRow = (seoReturnPolicyResults as { value?: string }[])[0];
  const returnPolicy = parseSeoReturnPolicySettings(seoReturnPolicyRow?.value);
  const businessMap = Object.fromEntries(
    (businessResults as { key: string; value: string }[]).map((row) => [
      row.key,
      row.value,
    ]),
  );
  const business = {
    companyName: businessMap.company_name ?? "",
    legalName: businessMap.legal_name ?? "",
    addressLine1: businessMap.address_line1 ?? "",
    addressLine2: businessMap.address_line2 ?? "",
    city: businessMap.city ?? "",
    stateRegion: businessMap.state_region ?? "",
    postalCode: businessMap.postal_code ?? "",
    country: businessMap.country ?? "Bangladesh",
    phone: businessMap.phone ?? "",
    email: businessMap.email ?? "",
    taxId: businessMap.tax_id ?? "",
  };

  return {
    analytics: processedAnalytics,
    header: headerData,
    navigation: navigationData,
    footer: footerData,
    currency: currencyData,
    theme: storefrontTheme,
    media,
    metaCapi,
    business,
    seo: {
      discovery,
      returnPolicy,
    },
  };
}
