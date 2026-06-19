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
  categories,
  pages,
  settings,
  WidgetPlacementScope,
  type Analytics,
} from "@scalius/database/schema";
import { eq, isNull, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  processAnalyticsScript,
  shouldUsePartytown,
} from "../../integrations/analytics";
import { resolveCollectionProductsBatch } from "../collections/collections.service";
import { parseMediaOptimizationSettings } from "../settings/site-settings.service";
import { sanitizeStorefrontThemeColors } from "@scalius/shared/storefront-theme";
import { getPublicPageBySlug } from "../pages/pages.service";
import {
  getActiveHomepageWidgets,
  getActiveWidgetPlacements,
} from "../widgets/widgets.service";
import type { Database } from "@scalius/database/client";

// ── Local helpers & interfaces ────────────────────────────────────────────────

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch (e: unknown) {
    console.warn(
      "[Storefront] JSON parse failed:",
      e instanceof Error ? e.message : e,
    );
    return fallback;
  }
}

const unixToISO = (timestamp: unknown): string | null => {
  try {
    if (timestamp === null || timestamp === undefined) return null;
    const numTimestamp =
      typeof timestamp === "number" ? timestamp : Number(timestamp);
    if (isNaN(numTimestamp) || numTimestamp <= 0) return null;
    const date = new Date(numTimestamp * 1000);
    if (!isNaN(date.getTime())) return date.toISOString();
  } catch (e: unknown) {
    console.warn(
      "[Storefront] Failed to convert unix timestamp to ISO:",
      e instanceof Error ? e.message : e,
    );
  }
  return null;
};

interface NestedNavigationItem {
  id?: string;
  title: string;
  href?: string;
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
 * Returns the final { seo, hero, widgets, collections } object for c.json().
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
        type: collections.type,
        config: collections.config,
        sortOrder: collections.sortOrder,
        isActive: collections.isActive,
      })
      .from(collections)
      .where(and(eq(collections.isActive, true), isNull(collections.deletedAt)))
      .orderBy(collections.sortOrder),
  ]);

  const [seoResults, heroResults, collectionResults] =
    batchResults;

  // Process SEO
  const seoSettings = (seoResults as Record<string, unknown>[])[0] || {
    siteTitle: "Scalius Commerce",
    homepageTitle: "Welcome to Scalius Commerce",
    homepageMetaDescription: "Your one-stop shop for everything amazing.",
  };

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
      images: safeJsonParse(slider.images as string, []),
    };
  };
  const hero = {
    desktop: formatSlider(desktopSlider),
    mobile: formatSlider(mobileSlider),
  };

  const formattedWidgets = await getActiveHomepageWidgets(db);

  // === BATCH 2: Products for collections ===
  const parsedCollections = (
    collectionResults as Record<string, unknown>[]
  ).map((col) => ({
    id: col.id as string,
    name: col.name as string,
    type: col.type as string,
    sortOrder: col.sortOrder as number,
    isActive: col.isActive as boolean,
    parsedConfig: safeJsonParse<Record<string, unknown>>(col.config as string, {}),
  }));

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
        type: col.type,
        config: {
          categoryIds: cfg.categoryIds,
          productIds: cfg.productIds,
          featuredProductId: cfg.featuredProductId,
          maxProducts: cfg.maxProducts,
          title: cfg.title,
          subtitle: cfg.subtitle,
        },
        sortOrder: col.sortOrder,
        isActive: col.isActive,
        categories: resolved.categories,
        products: resolved.products,
        featuredProduct: resolved.featuredProduct,
      };
    })
    .filter(Boolean);

  return {
    seo: seoSettings,
    hero,
    widgets: formattedWidgets,
    collections: formattedCollections,
  };
}

// ── CMS page render data ────────────────────────────────────────────────────

export async function getPageRenderData(db: Database, slug: string) {
  const page = await getPublicPageBySlug(db, slug);
  if (!page) return null;

  const widgets = await getActiveWidgetPlacements(db, {
    scope: WidgetPlacementScope.PAGE,
    scopeId: page.id,
  });

  return { page, widgets };
}

// ── Layout data ───────────────────────────────────────────────────────────────

/**
 * Fetch and shape all layout data in a single batched D1 round-trip.
 * Returns the final { analytics, header, navigation, footer, currency, theme } object.
 */
export async function getLayoutData(db: Database) {
  const batchResults = await db.batch([
    // 0. Analytics configurations
    db.select().from(analytics).where(eq(analytics.isActive, true)),

    // 1. Site settings (header + footer config)
    db
      .select({
        headerConfig: siteSettings.headerConfig,
        footerConfig: siteSettings.footerConfig,
      })
      .from(siteSettings)
      .limit(1),

    // 2. Categories (for navigation fallback)
    db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
      })
      .from(categories)
      .where(isNull(categories.deletedAt))
      .orderBy(categories.name),

    // 3. Published pages (for navigation fallback)
    db
      .select({ id: pages.id, title: pages.title, slug: pages.slug })
      .from(pages)
      .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
      .orderBy(pages.title),

    // 4. Currency settings
    db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.category, "currency")),

    // 5. Theme color overrides
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

    // 6. Media/image optimization settings
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
  ]);

  const [
    analyticsResults,
    settingsResults,
    categoriesData,
    pagesData,
    currencyResults,
    themeResults,
    mediaResults,
  ] = batchResults;

  // Process Analytics
  const processedAnalytics = (analyticsResults as Analytics[]).map(
    (script: Analytics) => {
      let processedConfig = script.config;
      if (shouldUsePartytown(script))
        processedConfig = processAnalyticsScript(script);
      return {
        id: script.id,
        name: script.name,
        type: script.type,
        isActive: script.isActive,
        usePartytown: script.usePartytown,
        config: processedConfig,
        location: script.location,
        createdAt: unixToISO(script.createdAt),
        updatedAt: unixToISO(script.updatedAt),
      };
    },
  );

  // Process Header + Navigation
  const siteSettingsData = (settingsResults as Record<string, unknown>[])[0] as
    | Record<string, string | null>
    | undefined;
  let headerData: Record<string, unknown>;
  let navigationData: NestedNavigationItem[] = [];

  if (siteSettingsData?.headerConfig) {
    const headerConfig = safeJsonParse<Record<string, unknown>>(
      siteSettingsData.headerConfig,
      {},
    );
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

    if (Array.isArray(headerConfig.navigation)) {
      navigationData = headerConfig.navigation as NestedNavigationItem[];
    } else {
      // Generate default navigation from categories + pages
      navigationData = [{ id: "home", title: "Home", href: "/" }];
      if ((categoriesData as unknown[]).length > 0) {
        navigationData.push({
          id: "categories",
          title: "Categories",
          href: "#",
          subMenu: (
            categoriesData as { id: string; name: string; slug: string }[]
          ).map((cat) => ({
            id: `cat_${cat.id}`,
            title: cat.name,
            href: `/categories/${cat.slug}`,
          })),
        });
      }
      (pagesData as { id: string; title: string; slug: string }[]).forEach(
        (page) => {
          navigationData.push({
            id: `page_${page.id}`,
            title: page.title,
            href: `/${page.slug}`,
          });
        },
      );
    }
  } else {
    headerData = {
      topBar: { text: "", isEnabled: false },
      logo: { src: "", alt: "" },
      favicon: { src: "/favicon.svg", alt: "" },
      contact: { phone: "", text: "", isEnabled: false },
      social: [],
    };
  }

  // Process Footer
  let footerData: Record<string, unknown>;
  if (siteSettingsData?.footerConfig) {
    const footerConfig = safeJsonParse<Record<string, unknown>>(
      siteSettingsData.footerConfig,
      {},
    );
    const footerLogoConfig = asRecord(footerConfig.logo);
    const footerFaviconConfig = asRecord(footerConfig.favicon);

    let footerSocialLinks: SocialLink[] = [];
    if (Array.isArray(footerConfig.social)) {
      footerSocialLinks = footerConfig.social.map(normalizeSocialLink);
    }

    const normalizedMenus = (Array.isArray(footerConfig.menus) ? footerConfig.menus : []).map(
      (menu: Record<string, unknown>) => ({
        id: menu.id || nanoid(),
        title: menu.title || "",
        links: menu.links || [],
      }),
    );

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
      menus: normalizedMenus,
      social: footerSocialLinks,
    };
  } else {
    footerData = {
      logo: { src: "", alt: "" },
      favicon: { src: "/favicon.svg", alt: "" },
      tagline: "",
      description: "",
      copyrightText: "",
      menus: [],
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
  const currencyData = {
    code: currencyMap.currency_code ?? "BDT",
    symbol: currencyMap.currency_symbol ?? "৳",
    usdExchangeRate: currencyMap.usd_exchange_rate
      ? parseFloat(currencyMap.usd_exchange_rate)
      : 1,
  };

  // Process Theme
  let themeColors: Record<string, string> = {};
  const themeRow = (themeResults as { value?: string }[])[0];
  if (themeRow?.value) {
    try {
      themeColors = sanitizeStorefrontThemeColors(JSON.parse(themeRow.value));
    } catch (e: unknown) {
      console.warn(
        "[Storefront] Failed to parse theme colors JSON:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  const mediaRow = (mediaResults as { value?: string }[])[0];
  const media = parseMediaOptimizationSettings(mediaRow?.value);

  return {
    analytics: processedAnalytics,
    header: headerData,
    navigation: navigationData,
    footer: footerData,
    currency: currencyData,
    theme: { colors: themeColors },
    media,
  };
}
