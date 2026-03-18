// src/modules/storefront/storefront.service.ts
// Data query and shaping functions for the storefront API.
// Extracted from src/server/routes/storefront.ts — zero logic changes.
//
// These functions perform the heavy batched D1 queries and normalise the data.
// Route handlers simply call a function and return c.json(result).

import {
    siteSettings,
    products,
    categories,
    collections,
    widgets,
    heroSliders,
    analytics,
    pages,
    settings,
    type Analytics,
} from "@scalius/database/schema";
import { eq, isNull, and, inArray, asc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { processAnalyticsScript, shouldUsePartytown } from "../../integrations/analytics";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";
import type { Database } from "@scalius/database/client";

// ── Local helpers & interfaces ────────────────────────────────────────────────

const unixToISO = (timestamp: unknown): string | null => {
    try {
        if (timestamp === null || timestamp === undefined) return null;
        const numTimestamp = typeof timestamp === "number" ? timestamp : Number(timestamp);
        if (isNaN(numTimestamp) || numTimestamp <= 0) return null;
        const date = new Date(numTimestamp * 1000);
        if (!isNaN(date.getTime())) return date.toISOString();
    } catch {
        // ignore
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

const buildProductSelect = () => ({
    id: products.id,
    name: products.name,
    slug: products.slug,
    price: products.price,
    discountType: products.discountType,
    discountPercentage: products.discountPercentage,
    discountAmount: products.discountAmount,
    freeDelivery: products.freeDelivery,
    categoryId: products.categoryId,
    imageUrl: sql<string | null>`(
    SELECT "product_images"."url"
    FROM "product_images"
    WHERE "product_images"."product_id" = "products"."id"
      AND "product_images"."is_primary" = 1
    ORDER BY "product_images"."sort_order" ASC
    LIMIT 1
  )`.as("imageUrl"),
    hasVariants: sql<boolean>`(
    SELECT COUNT(*) > 0
    FROM "product_variants"
    WHERE "product_variants"."product_id" = "products"."id"
      AND "product_variants"."deleted_at" IS NULL
  )`.as("hasVariants"),
});

// ── Homepage data ─────────────────────────────────────────────────────────────

/**
 * Fetch and shape all homepage data in two batched D1 round-trips.
 * Returns the final { seo, hero, widgets, collections } object for c.json().
 */
export async function getHomepageData(db: Database) {
    // === BATCH 1: Independent top-level queries ===
    const batchResults = await db.batch([
        // 0. SEO settings
        db.select({
            siteTitle: siteSettings.siteTitle,
            homepageTitle: siteSettings.homepageTitle,
            homepageMetaDescription: siteSettings.homepageMetaDescription,
        }).from(siteSettings).limit(1),

        // 1. Hero sliders (desktop and mobile)
        db.select().from(heroSliders).where(and(eq(heroSliders.isActive, true), isNull(heroSliders.deletedAt))),

        // 2. Active homepage widgets
        db
            .select()
            .from(widgets)
            .where(and(eq(widgets.isActive, true), eq(widgets.displayTarget, "homepage"), isNull(widgets.deletedAt)))
            .orderBy(asc(widgets.placementRule), asc(widgets.sortOrder)),

        // 3. Active collections (metadata only)
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

    const [seoResults, heroResults, widgetResults, collectionResults] = batchResults;

    // Process SEO
    const seoSettings = (seoResults as Record<string, unknown>[])[0] || {
        siteTitle: "Scalius Commerce",
        homepageTitle: "Welcome to Scalius Commerce",
        homepageMetaDescription: "Your one-stop shop for everything amazing.",
    };

    // Process Hero
    const desktopSlider = (heroResults as { type: string }[]).find((s) => s.type === "desktop");
    const mobileSlider = (heroResults as { type: string }[]).find((s) => s.type === "mobile");
    const formatSlider = (slider: Record<string, unknown> | undefined) => {
        if (!slider) return null;
        return { id: slider.id, type: slider.type, images: JSON.parse((slider.images as string) || "[]") };
    };
    const hero = { desktop: formatSlider(desktopSlider), mobile: formatSlider(mobileSlider) };

    // Process Widgets
    const formattedWidgets = (widgetResults as Record<string, unknown>[]).map((widget) => ({
        id: widget.id,
        name: widget.name,
        htmlContent: widget.htmlContent,
        cssContent: widget.cssContent,
        isActive: widget.isActive,
        displayTarget: widget.displayTarget,
        placementRule: widget.placementRule,
        referenceCollectionId: widget.referenceCollectionId,
        sortOrder: widget.sortOrder,
    }));

    // === BATCH 2: Products for collections ===
    const parsedCollections = (collectionResults as Record<string, unknown>[]).map((col) => ({
        id: col.id as string,
        name: col.name as string,
        type: col.type as string,
        sortOrder: col.sortOrder as number,
        isActive: col.isActive as boolean,
        parsedConfig: JSON.parse((col.config as string) || "{}"),
    }));

    const allProductIds = new Set<string>();
    const allCategoryIds = new Set<string>();
    const allFeaturedProductIds = new Set<string>();

    for (const col of parsedCollections) {
        const cfg = col.parsedConfig;
        if (Array.isArray(cfg.productIds)) cfg.productIds.forEach((id: string) => allProductIds.add(id));
        if (Array.isArray(cfg.categoryIds)) cfg.categoryIds.forEach((id: string) => allCategoryIds.add(id));
        if (cfg.featuredProductId) allFeaturedProductIds.add(cfg.featuredProductId);
    }

    const productIdsArr = Array.from(allProductIds);
    const categoryIdsArr = Array.from(allCategoryIds);
    const featuredIdsArr = Array.from(allFeaturedProductIds);

    const productBatchResults = await db.batch([
        // 0. Specific products by ID
        productIdsArr.length > 0
            ? db.select(buildProductSelect()).from(products).where(and(inArray(products.id, productIdsArr), eq(products.isActive, true), isNull(products.deletedAt)))
            : db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`),

        // 1. Products by category
        categoryIdsArr.length > 0
            ? db.select(buildProductSelect()).from(products).where(and(inArray(products.categoryId, categoryIdsArr), eq(products.isActive, true), isNull(products.deletedAt)))
            : db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`),

        // 2. Category metadata
        categoryIdsArr.length > 0
            ? db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(and(inArray(categories.id, categoryIdsArr), isNull(categories.deletedAt)))
            : db.select({ id: sql`NULL` }).from(categories).where(sql`1 = 0`),

        // 3. Featured products
        featuredIdsArr.length > 0
            ? db.select(buildProductSelect()).from(products).where(and(inArray(products.id, featuredIdsArr), eq(products.isActive, true), isNull(products.deletedAt)))
            : db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`),
    ]);

    // Build lookup maps
    const specificProductsById = new Map<string, Record<string, unknown>>();
    const categoryProductsByCategoryId = new Map<string, Record<string, unknown>[]>();
    const categoryMetadataById = new Map<string, Record<string, unknown>>();
    const featuredProductsById = new Map<string, Record<string, unknown>>();

    for (const prod of productBatchResults[0] as Record<string, unknown>[]) {
        if (prod.id && prod.id !== null) {
            specificProductsById.set(prod.id as string, {
                ...prod,
                discountedPrice: calculateDiscountedPrice(prod.price as number, prod.discountType as string | null, prod.discountPercentage as number | null, prod.discountAmount as number | null),
            });
        }
    }
    for (const prod of productBatchResults[1] as Record<string, unknown>[]) {
        if (prod.categoryId) {
            if (!categoryProductsByCategoryId.has(prod.categoryId as string)) categoryProductsByCategoryId.set(prod.categoryId as string, []);
            categoryProductsByCategoryId.get(prod.categoryId as string)!.push({
                ...prod,
                discountedPrice: calculateDiscountedPrice(prod.price as number, prod.discountType as string | null, prod.discountPercentage as number | null, prod.discountAmount as number | null),
            });
        }
    }
    for (const cat of productBatchResults[2] as Record<string, unknown>[]) {
        if (cat.id && cat.id !== null) categoryMetadataById.set(cat.id as string, cat);
    }
    for (const prod of productBatchResults[3] as Record<string, unknown>[]) {
        if (prod.id && prod.id !== null) {
            featuredProductsById.set(prod.id as string, {
                ...prod,
                discountedPrice: calculateDiscountedPrice(prod.price as number, prod.discountType as string | null, prod.discountPercentage as number | null, prod.discountAmount as number | null),
            });
        }
    }

    // Build final collections array
    const formattedCollections = parsedCollections
        .map((col) => {
            const cfg = col.parsedConfig;
            const productIds: string[] = Array.isArray(cfg.productIds) ? cfg.productIds : [];
            const categoryIds: string[] = Array.isArray(cfg.categoryIds) ? cfg.categoryIds : [];
            const maxProducts = Math.min(Math.max(cfg.maxProducts || 8, 1), 24);

            let collectionProducts: Record<string, unknown>[] = [];
            let collectionCategories: Record<string, unknown>[] = [];
            let featuredProduct: Record<string, unknown> | null = null;

            if (productIds.length > 0) {
                collectionProducts = productIds.map((id) => specificProductsById.get(id)).filter((p): p is Record<string, unknown> => p != null).slice(0, maxProducts);
                collectionCategories = [];
            } else if (categoryIds.length > 0) {
                const categoryProducts: Record<string, unknown>[] = [];
                for (const catId of categoryIds) {
                    categoryProducts.push(...(categoryProductsByCategoryId.get(catId) || []));
                }
                const seen = new Set<string>();
                collectionProducts = categoryProducts.filter((p) => { if (seen.has(p.id as string)) return false; seen.add(p.id as string); return true; }).slice(0, maxProducts);
                collectionCategories = categoryIds.map((id) => categoryMetadataById.get(id)).filter((c): c is Record<string, unknown> => c != null);
            }

            if (cfg.featuredProductId) {
                featuredProduct = featuredProductsById.get(cfg.featuredProductId) || null;
            }

            // Skip empty collections
            if (collectionProducts.length === 0) return null;

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
                categories: collectionCategories,
                products: collectionProducts,
                featuredProduct,
            };
        })
        .filter(Boolean);

    return { seo: seoSettings, hero, widgets: formattedWidgets, collections: formattedCollections };
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
        db.select({ headerConfig: siteSettings.headerConfig, footerConfig: siteSettings.footerConfig }).from(siteSettings).limit(1),

        // 2. Categories (for navigation fallback)
        db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(isNull(categories.deletedAt)).orderBy(categories.name),

        // 3. Published pages (for navigation fallback)
        db.select({ id: pages.id, title: pages.title, slug: pages.slug }).from(pages).where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`).orderBy(pages.title),

        // 4. Currency settings
        db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "currency")),

        // 5. Theme color overrides
        db.select({ value: settings.value }).from(settings).where(and(eq(settings.category, "theme"), eq(settings.key, "storefront_colors"))).limit(1),
    ]);

    const [analyticsResults, settingsResults, categoriesData, pagesData, currencyResults, themeResults] = batchResults;

    // Process Analytics
    const processedAnalytics = (analyticsResults as Analytics[]).map((script: Analytics) => {
        let processedConfig = script.config;
        if (shouldUsePartytown(script)) processedConfig = processAnalyticsScript(script);
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
    });

    // Process Header + Navigation
    const siteSettingsData = (settingsResults as Record<string, unknown>[])[0] as Record<string, string | null> | undefined;
    let headerData: Record<string, unknown>;
    let navigationData: NestedNavigationItem[] = [];

    if (siteSettingsData?.headerConfig) {
        const headerConfig = JSON.parse(siteSettingsData.headerConfig);

        // Normalize social links — supports both array and legacy { facebook: "url" } format
        let socialLinks: SocialLink[] = [];
        if (Array.isArray(headerConfig.social)) {
            socialLinks = headerConfig.social;
        } else if (headerConfig.social && typeof headerConfig.social === "object") {
            Object.entries(headerConfig.social).forEach(([platform, url]) => {
                if (url && typeof url === "string") {
                    socialLinks.push({ id: platform, label: platform.charAt(0).toUpperCase() + platform.slice(1), url });
                }
            });
        }

        headerData = {
            topBar: { text: headerConfig.topBar?.text || "", isEnabled: headerConfig.topBar?.isEnabled ?? true },
            logo: { src: headerConfig.logo?.src || "", alt: headerConfig.logo?.alt || "" },
            favicon: { src: headerConfig.favicon?.src || "/favicon.svg", alt: headerConfig.favicon?.alt || "" },
            contact: { phone: headerConfig.contact?.phone || "", text: headerConfig.contact?.text || "", isEnabled: headerConfig.contact?.isEnabled ?? true },
            social: socialLinks,
        };

        if (headerConfig.navigation) {
            navigationData = headerConfig.navigation;
        } else {
            // Generate default navigation from categories + pages
            navigationData = [{ id: "home", title: "Home", href: "/" }];
            if ((categoriesData as unknown[]).length > 0) {
                navigationData.push({
                    id: "categories",
                    title: "Categories",
                    href: "#",
                    subMenu: (categoriesData as { id: string; name: string; slug: string }[]).map((cat) => ({
                        id: `cat_${cat.id}`,
                        title: cat.name,
                        href: `/categories/${cat.slug}`,
                    })),
                });
            }
            (pagesData as { id: string; title: string; slug: string }[]).forEach((page) => {
                navigationData.push({ id: `page_${page.id}`, title: page.title, href: `/${page.slug}` });
            });
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
        const footerConfig = JSON.parse(siteSettingsData.footerConfig);

        let footerSocialLinks: SocialLink[] = [];
        if (Array.isArray(footerConfig.social)) {
            footerSocialLinks = footerConfig.social.map((link: Record<string, unknown>) => ({
                id: link.id || nanoid(),
                label: link.label || link.platform || "",
                url: link.url || "",
                iconUrl: link.iconUrl || link.icon,
            }));
        }

        const normalizedMenus = (footerConfig.menus || []).map((menu: Record<string, unknown>) => ({
            id: menu.id || nanoid(),
            title: menu.title || "",
            links: menu.links || [],
        }));

        footerData = {
            logo: { src: footerConfig.logo?.src || "", alt: footerConfig.logo?.alt || "" },
            favicon: { src: footerConfig.favicon?.src || "/favicon.svg", alt: footerConfig.favicon?.alt || "" },
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
    const currencyMap = Object.fromEntries((currencyResults as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    const currencyData = {
        code: currencyMap.currency_code ?? "BDT",
        symbol: currencyMap.currency_symbol ?? "৳",
        usdExchangeRate: currencyMap.usd_exchange_rate ? parseFloat(currencyMap.usd_exchange_rate) : 1,
    };

    // Process Theme
    let themeColors: Record<string, string> = {};
    const themeRow = (themeResults as { value?: string }[])[0];
    if (themeRow?.value) {
        try { themeColors = JSON.parse(themeRow.value); } catch { /* ignore corrupt JSON */ }
    }

    return {
        analytics: processedAnalytics,
        header: headerData,
        navigation: navigationData,
        footer: footerData,
        currency: currencyData,
        theme: { colors: themeColors },
    };
}
