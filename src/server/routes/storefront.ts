// src/server/routes/storefront.ts
// Consolidated storefront endpoints for maximum performance
// Reduces multiple API calls to single optimized requests

import { Hono } from "hono";
import {
  siteSettings,
  products,
  categories,
  collections,
  widgets,
  heroSliders,
  analytics,
  pages,
  type Analytics,
} from "@/db/schema";
import { eq, isNull, and, inArray, asc, sql } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { nanoid } from "nanoid";
import {
  processAnalyticsScript,
  shouldUsePartytown,
} from "../../lib/analytics";

const app = new Hono<{ Bindings: Env }>();

// =============================================
// UTILITY FUNCTIONS
// =============================================

// Helper function to convert Unix timestamp to ISO string
const unixToISO = (timestamp: unknown): string | null => {
  try {
    if (timestamp === null || timestamp === undefined) return null;
    const numTimestamp =
      typeof timestamp === "number" ? timestamp : Number(timestamp);
    if (isNaN(numTimestamp) || numTimestamp <= 0) return null;
    const date = new Date(numTimestamp * 1000);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  } catch {
    // Ignore invalid timestamps
  }
  return null;
};

// Nested navigation item interface
interface NestedNavigationItem {
  id?: string;
  title: string;
  href?: string;
  subMenu?: NestedNavigationItem[];
}

// Social link interface
interface SocialLink {
  id: string;
  label: string;
  url: string;
  iconUrl?: string;
}

// Calculate discounted price helper
const calculateDiscountedPrice = (
  price: number,
  discountType: string | null,
  discountPercentage: number | null,
  discountAmount: number | null,
): number => {
  if (!discountType) return price;
  if (discountType === "percentage" && discountPercentage) {
    return Math.round(price * (1 - discountPercentage / 100) * 100) / 100;
  }
  if (discountType === "flat" && discountAmount) {
    return Math.max(0, price - discountAmount);
  }
  return price;
};

// =============================================
// GET /storefront/homepage
// Consolidated homepage data endpoint
// Reduces 4 + N API calls to 1
// =============================================
app.get(
  "/homepage",
  cacheMiddleware({
    ttl: 3600000,
    keyPrefix: "api:storefront:homepage:",
    varyByQuery: false,
    methods: ["GET"],
  }),
  async (c) => {
    try {
      const db = c.get("db");

      // === STEP 1: Execute all independent queries in a single batch ===
      // This sends all queries to Turso in ONE HTTP request
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

        // 2. Active homepage widgets
        db
          .select()
          .from(widgets)
          .where(
            and(
              eq(widgets.isActive, true),
              eq(widgets.displayTarget, "homepage"),
              isNull(widgets.deletedAt),
            ),
          )
          .orderBy(asc(widgets.placementRule), asc(widgets.sortOrder)),

        // 3. Active collections (metadata only, products fetched in step 2)
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
          .where(
            and(eq(collections.isActive, true), isNull(collections.deletedAt)),
          )
          .orderBy(collections.sortOrder),
      ]);

      // Extract results
      const [seoResults, heroResults, widgetResults, collectionResults] =
        batchResults;

      // === PROCESS SEO ===
      const seoSettings = seoResults[0] || {
        siteTitle: "Scalius Commerce",
        homepageTitle: "Welcome to Scalius Commerce",
        homepageMetaDescription: "Your one-stop shop for everything amazing.",
      };

      // === PROCESS HERO ===
      const desktopSlider = heroResults.find((s: any) => s.type === "desktop");
      const mobileSlider = heroResults.find((s: any) => s.type === "mobile");

      const formatSlider = (slider: any) => {
        if (!slider) return null;
        return {
          id: slider.id,
          type: slider.type,
          images: JSON.parse(slider.images || "[]"),
        };
      };

      const hero = {
        desktop: formatSlider(desktopSlider),
        mobile: formatSlider(mobileSlider),
      };

      // === PROCESS WIDGETS ===
      const formattedWidgets = widgetResults.map((widget: any) => ({
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

      // === STEP 2: PROCESS COLLECTIONS WITH PRODUCTS ===
      // Now we need to fetch products for each collection
      // This is more complex because each collection can have different product selection logic

      // Parse all collection configs first
      const parsedCollections = collectionResults.map((col: any) => ({
        ...col,
        parsedConfig: JSON.parse(col.config || "{}"),
      }));

      // Collect all unique product IDs, category IDs, and featured product IDs
      const allProductIds = new Set<string>();
      const allCategoryIds = new Set<string>();
      const allFeaturedProductIds = new Set<string>();

      for (const col of parsedCollections) {
        const cfg = col.parsedConfig;
        if (Array.isArray(cfg.productIds)) {
          cfg.productIds.forEach((id: string) => allProductIds.add(id));
        }
        if (Array.isArray(cfg.categoryIds)) {
          cfg.categoryIds.forEach((id: string) => allCategoryIds.add(id));
        }
        if (cfg.featuredProductId) {
          allFeaturedProductIds.add(cfg.featuredProductId);
        }
      }

      // === STEP 2.1: Batch fetch products for all collections ===
      // Build batch queries as a tuple - all 4 queries always present
      // Queries return empty results if no IDs to query
      const productIdsArr = Array.from(allProductIds);
      const categoryIdsArr = Array.from(allCategoryIds);
      const featuredIdsArr = Array.from(allFeaturedProductIds);

      // Helper to build product select with inline image subquery
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

      // Execute second batch with 4 fixed queries
      const productBatchResults = await db.batch([
        // 0. Specific products by ID
        productIdsArr.length > 0
          ? db
              .select(buildProductSelect())
              .from(products)
              .where(
                and(
                  inArray(products.id, productIdsArr),
                  eq(products.isActive, true),
                  isNull(products.deletedAt),
                ),
              )
          : db
              .select({ id: sql`NULL` })
              .from(products)
              .where(sql`1 = 0`),

        // 1. Products by category
        categoryIdsArr.length > 0
          ? db
              .select(buildProductSelect())
              .from(products)
              .where(
                and(
                  inArray(products.categoryId, categoryIdsArr),
                  eq(products.isActive, true),
                  isNull(products.deletedAt),
                ),
              )
          : db
              .select({ id: sql`NULL` })
              .from(products)
              .where(sql`1 = 0`),

        // 2. Category metadata
        categoryIdsArr.length > 0
          ? db
              .select({
                id: categories.id,
                name: categories.name,
                slug: categories.slug,
              })
              .from(categories)
              .where(
                and(
                  inArray(categories.id, categoryIdsArr),
                  isNull(categories.deletedAt),
                ),
              )
          : db
              .select({ id: sql`NULL` })
              .from(categories)
              .where(sql`1 = 0`),

        // 3. Featured products
        featuredIdsArr.length > 0
          ? db
              .select(buildProductSelect())
              .from(products)
              .where(
                and(
                  inArray(products.id, featuredIdsArr),
                  eq(products.isActive, true),
                  isNull(products.deletedAt),
                ),
              )
          : db
              .select({ id: sql`NULL` })
              .from(products)
              .where(sql`1 = 0`),
      ]);

      // Create lookup maps
      const specificProductsById = new Map<string, any>();
      const categoryProductsByCategoryId = new Map<string, any[]>();
      const categoryMetadataById = new Map<string, any>();
      const featuredProductsById = new Map<string, any>();

      // Process specific products (index 0)
      for (const prod of productBatchResults[0] as any[]) {
        if (prod.id && prod.id !== null) {
          specificProductsById.set(prod.id, {
            ...prod,
            discountedPrice: calculateDiscountedPrice(
              prod.price,
              prod.discountType,
              prod.discountPercentage,
              prod.discountAmount,
            ),
          });
        }
      }

      // Process category products (index 1)
      for (const prod of productBatchResults[1] as any[]) {
        if (prod.categoryId) {
          if (!categoryProductsByCategoryId.has(prod.categoryId)) {
            categoryProductsByCategoryId.set(prod.categoryId, []);
          }
          categoryProductsByCategoryId.get(prod.categoryId)!.push({
            ...prod,
            discountedPrice: calculateDiscountedPrice(
              prod.price,
              prod.discountType,
              prod.discountPercentage,
              prod.discountAmount,
            ),
          });
        }
      }

      // Process category metadata (index 2)
      for (const cat of productBatchResults[2] as any[]) {
        if (cat.id && cat.id !== null) {
          categoryMetadataById.set(cat.id, cat);
        }
      }

      // Process featured products (index 3)
      for (const prod of productBatchResults[3] as any[]) {
        if (prod.id && prod.id !== null) {
          featuredProductsById.set(prod.id, {
            ...prod,
            discountedPrice: calculateDiscountedPrice(
              prod.price,
              prod.discountType,
              prod.discountPercentage,
              prod.discountAmount,
            ),
          });
        }
      }

      // === STEP 3: BUILD FINAL COLLECTIONS ARRAY ===
      const formattedCollections = parsedCollections
        .map((col: any) => {
          const cfg = col.parsedConfig;
          const productIds: string[] = Array.isArray(cfg.productIds)
            ? cfg.productIds
            : [];
          const categoryIds: string[] = Array.isArray(cfg.categoryIds)
            ? cfg.categoryIds
            : [];
          const maxProducts = Math.min(Math.max(cfg.maxProducts || 8, 1), 24);

          let collectionProducts: any[] = [];
          let collectionCategories: any[] = [];
          let featuredProduct: any = null;

          // Product selection priority: productIds > categoryIds
          if (productIds.length > 0) {
            // Use specific products - maintain order from productIds
            collectionProducts = productIds
              .map((id) => specificProductsById.get(id))
              .filter(Boolean)
              .slice(0, maxProducts);
            // No categories when using specific products
            collectionCategories = [];
          } else if (categoryIds.length > 0) {
            // Get products from categories
            const categoryProducts: any[] = [];
            for (const catId of categoryIds) {
              const prods = categoryProductsByCategoryId.get(catId) || [];
              categoryProducts.push(...prods);
            }
            // Deduplicate and limit
            const seen = new Set<string>();
            collectionProducts = categoryProducts
              .filter((p) => {
                if (seen.has(p.id)) return false;
                seen.add(p.id);
                return true;
              })
              .slice(0, maxProducts);

            // Get category metadata
            collectionCategories = categoryIds
              .map((id) => categoryMetadataById.get(id))
              .filter(Boolean);
          }

          // Get featured product
          if (cfg.featuredProductId) {
            featuredProduct =
              featuredProductsById.get(cfg.featuredProductId) || null;
          }

          // Skip collections with no products
          if (collectionProducts.length === 0) {
            return null;
          }

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

      // === RETURN CONSOLIDATED RESPONSE ===
      return c.json({
        success: true,
        data: {
          seo: seoSettings,
          hero,
          widgets: formattedWidgets,
          collections: formattedCollections,
        },
      });
    } catch (error) {
      console.error("Error fetching homepage data:", error);
      return c.json(
        {
          success: false,
          error: "Failed to fetch homepage data",
          message: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// =============================================
// GET /storefront/layout
// Consolidated layout data endpoint
// Reduces 4 API calls to 1
// =============================================
app.get(
  "/layout",
  cacheMiddleware({
    ttl: 3600000,
    keyPrefix: "api:storefront:layout:",
    varyByQuery: false,
    methods: ["GET"],
  }),
  async (c) => {
    try {
      const db = c.get("db");

      // === SINGLE BATCH: Fetch all layout data in ONE HTTP request ===
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
          .select({
            id: pages.id,
            title: pages.title,
            slug: pages.slug,
          })
          .from(pages)
          .where(
            sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`,
          )
          .orderBy(pages.title),
      ]);

      const [analyticsResults, settingsResults, categoriesData, pagesData] =
        batchResults;

      // === PROCESS ANALYTICS ===
      const processedAnalytics = (analyticsResults as any[]).map(
        (script: Analytics) => {
          let processedConfig = script.config;
          if (shouldUsePartytown(script)) {
            processedConfig = processAnalyticsScript(script);
          }
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

      // === PROCESS HEADER ===
      const settings = settingsResults[0] as any;
      let headerData: any = null;
      let navigationData: NestedNavigationItem[] = [];

      if (settings?.headerConfig) {
        const headerConfig = JSON.parse(settings.headerConfig);

        // Normalize social links
        let socialLinks: SocialLink[] = [];
        if (Array.isArray(headerConfig.social)) {
          socialLinks = headerConfig.social;
        } else if (
          headerConfig.social &&
          typeof headerConfig.social === "object"
        ) {
          // Legacy format: { facebook: "url" }
          Object.entries(headerConfig.social).forEach(([platform, url]) => {
            if (url && typeof url === "string") {
              socialLinks.push({
                id: platform,
                label: platform.charAt(0).toUpperCase() + platform.slice(1),
                url: url,
              });
            }
          });
        }

        headerData = {
          topBar: {
            text: headerConfig.topBar?.text || "",
            isEnabled: headerConfig.topBar?.isEnabled ?? true,
          },
          logo: {
            src: headerConfig.logo?.src || "",
            alt: headerConfig.logo?.alt || "",
          },
          favicon: {
            src: headerConfig.favicon?.src || "/favicon.svg",
            alt: headerConfig.favicon?.alt || "",
          },
          contact: {
            phone: headerConfig.contact?.phone || "",
            text: headerConfig.contact?.text || "",
            isEnabled: headerConfig.contact?.isEnabled ?? true,
          },
          social: socialLinks,
        };

        // Get navigation from header config or generate default
        if (headerConfig.navigation) {
          navigationData = headerConfig.navigation;
        } else {
          // Generate default navigation from categories and pages
          navigationData = [{ id: "home", title: "Home", href: "/" }];

          if ((categoriesData as any[]).length > 0) {
            navigationData.push({
              id: "categories",
              title: "Categories",
              href: "#",
              subMenu: (categoriesData as any[]).map((cat) => ({
                id: `cat_${cat.id}`,
                title: cat.name,
                href: `/categories/${cat.slug}`,
              })),
            });
          }

          (pagesData as any[]).forEach((page) => {
            navigationData.push({
              id: `page_${page.id}`,
              title: page.title,
              href: `/${page.slug}`,
            });
          });
        }
      } else {
        // Default header data
        headerData = {
          topBar: { text: "", isEnabled: false },
          logo: { src: "", alt: "" },
          favicon: { src: "/favicon.svg", alt: "" },
          contact: { phone: "", text: "", isEnabled: false },
          social: [],
        };
      }

      // === PROCESS FOOTER ===
      let footerData: any = null;

      if (settings?.footerConfig) {
        const footerConfig = JSON.parse(settings.footerConfig);

        // Normalize social links
        let footerSocialLinks: SocialLink[] = [];
        if (Array.isArray(footerConfig.social)) {
          footerSocialLinks = footerConfig.social.map((link: any) => ({
            id: link.id || nanoid(),
            label: link.label || link.platform || "",
            url: link.url || "",
            iconUrl: link.iconUrl || link.icon,
          }));
        }

        // Process menus - keep the links array as nested for frontend
        const normalizedMenus = (footerConfig.menus || []).map((menu: any) => ({
          id: menu.id || nanoid(),
          title: menu.title || "",
          links: menu.links || [],
        }));

        footerData = {
          logo: {
            src: footerConfig.logo?.src || "",
            alt: footerConfig.logo?.alt || "",
          },
          favicon: {
            src: footerConfig.favicon?.src || "/favicon.svg",
            alt: footerConfig.favicon?.alt || "",
          },
          tagline: footerConfig.tagline || "",
          description: footerConfig.description || "",
          copyrightText: footerConfig.copyrightText || "",
          menus: normalizedMenus,
          social: footerSocialLinks,
        };
      } else {
        // Default footer data
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

      // === RETURN CONSOLIDATED RESPONSE ===
      return c.json({
        success: true,
        data: {
          analytics: processedAnalytics,
          header: headerData,
          navigation: navigationData,
          footer: footerData,
        },
      });
    } catch (error) {
      console.error("Error fetching layout data:", error);
      return c.json(
        {
          success: false,
          error: "Failed to fetch layout data",
          message: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

export { app as storefrontRoutes };
