// src/server/routes/storefront.ts
// Storefront API — thin HTTP layer.
// All query logic lives in src/modules/storefront/storefront.service.ts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import {
  getHomepageData,
  getLayoutData,
  getPageRenderData,
} from "@scalius/core/modules/storefront/storefront.service";
import { resolveThemePreviewSession } from "@scalius/core/modules/settings/site-settings.service";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { pageSchema } from "../schemas/entities";
const app = new OpenAPIHono<{ Bindings: Env }>();

const flexibleObjectSchema = z.record(z.string(), z.any());
const storefrontProductCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  price: z.number(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  discountedPrice: z.number(),
  priceVaries: z.boolean(),
  availableForSale: z.boolean(),
  freeDelivery: z.boolean(),
  categoryId: z.string().nullable(),
  hasVariants: z.boolean(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
});
const storefrontCategoryCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});
const collectionConfigSchema = z.object({
  maxProducts: z.number().int().min(1).max(24),
  title: z.string(),
  subtitle: z.string(),
});
const heroSlideSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  link: z.string(),
  focalPoint: z.object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
  }),
});
const heroSliderSchema = z.object({
  id: z.string(),
  type: z.string(),
  images: z.array(heroSlideSchema).max(12),
});
const homepageDataSchema = z.object({
  seo: z.object({
    siteTitle: z.string().nullable(),
    homepageTitle: z.string().nullable(),
    homepageMetaDescription: z.string().nullable(),
  }),
  hero: z.object({
    desktop: heroSliderSchema.nullable(),
    mobile: heroSliderSchema.nullable(),
  }),
  collections: z.array(z.object({
    id: z.string(),
    name: z.string(),
    presentation: z.string(),
    config: collectionConfigSchema,
    sortOrder: z.number(),
    isActive: z.boolean(),
    categories: z.array(storefrontCategoryCardSchema),
    products: z.array(storefrontProductCardSchema).max(24),
    featuredProduct: storefrontProductCardSchema.nullable(),
  })),
  presentation: z.object({
    categoryRail: z.object({
      enabled: z.boolean(),
      title: z.string(),
      categories: z.array(storefrontCategoryCardSchema.extend({
        description: z.string().nullable(),
        imageUrl: z.string().nullable(),
        canonicalPath: z.string().nullable(),
      })).max(12),
    }),
    trustStrip: z.object({
      enabled: z.boolean(),
      items: z.array(z.object({
        kind: z.enum(["delivery", "returns"]),
        title: z.string(),
        detail: z.string(),
        href: z.string().optional(),
      })).max(2),
    }),
  }),
});
type HomepageData = z.infer<typeof homepageDataSchema>;

const navigationLeafSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  href: z.string().optional(),
  openInNewTab: z.boolean().optional(),
});
const navigationChildSchema = navigationLeafSchema.extend({
  subMenu: z.array(navigationLeafSchema).optional(),
});
const navigationItemSchema = navigationLeafSchema.extend({
  subMenu: z.array(navigationChildSchema).optional(),
});
const socialLinkSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  iconUrl: z.string().optional(),
});
const headerSchema = z.object({
  topBar: z.object({ text: z.string(), isEnabled: z.boolean() }),
  logo: z.object({ src: z.string(), alt: z.string(), width: z.number().int() }),
  favicon: z.object({ src: z.string(), alt: z.string() }),
  contact: z.object({ phone: z.string(), text: z.string(), isEnabled: z.boolean() }),
  social: z.array(socialLinkSchema),
});
const footerSchema = z.object({
  logo: z.object({ src: z.string(), alt: z.string() }),
  favicon: z.object({ src: z.string(), alt: z.string() }),
  tagline: z.string(),
  description: z.string(),
  copyrightText: z.string(),
  menus: z.array(z.object({
    id: z.string(),
    title: z.string(),
    links: z.array(navigationItemSchema),
  })),
  social: z.array(socialLinkSchema),
});
const discoverySchema = z.object({
  sitemap: z.object({
    enabled: z.boolean(),
    staticPages: z.boolean(),
    products: z.boolean(),
    categories: z.boolean(),
    collections: z.boolean(),
    pages: z.boolean(),
    articles: z.boolean(),
  }),
  feeds: z.object({
    productCatalogEnabled: z.boolean(),
    includeUnavailableProducts: z.boolean(),
    variantStrategy: z.enum(["products", "variants"]),
    title: z.string(),
    description: z.string(),
  }),
  robots: z.object({ advertiseSitemap: z.boolean() }),
  structuredData: z.object({
    organization: z.boolean(),
    websiteSearch: z.boolean(),
    products: z.boolean(),
    productGroups: z.boolean(),
    offerShippingDetails: z.boolean(),
    breadcrumbs: z.boolean(),
    collections: z.boolean(),
    articles: z.boolean(),
  }),
});
const returnPolicySchema = z.object({
  enabled: z.boolean(),
  country: z.string(),
  category: z.enum(["finite", "unlimited", "no_returns"]),
  returnWindowDays: z.number().int().min(1).max(365).nullable(),
  returnFees: z.enum(["free", "customer_responsibility"]),
  returnMethod: z.enum(["mail", "in_store", "both"]),
  policyUrl: z.string(),
});
const layoutDataSchema = z.object({
  analytics: z.array(z.object({
    id: z.string(),
    type: z.string(),
    usePartytown: z.boolean(),
    config: z.string(),
    location: z.string(),
  })),
  header: headerSchema,
  navigation: z.array(navigationItemSchema),
  footer: footerSchema,
  currency: z.object({
    code: z.string(),
    symbol: z.string(),
    usdExchangeRate: z.number().positive(),
  }),
  theme: z.object({
    colors: z.record(z.string(), z.string()),
    typography: z.object({
      heading: z.enum(["system", "modern", "editorial"]),
      body: z.enum(["system", "modern", "humanist"]),
      scale: z.enum(["compact", "standard", "generous"]),
    }),
    cornerStyle: z.enum(["square", "subtle", "rounded"]),
    density: z.enum(["compact", "comfortable", "airy"]),
    containerWidth: z.enum(["focused", "standard", "wide"]),
    components: z.object({
      buttons: z.enum(["solid", "soft", "outline"]),
      inputs: z.enum(["outlined", "filled"]),
      cards: z.enum(["bordered", "elevated", "flat"]),
    }),
  }),
  media: z.object({
    enabled: z.boolean(),
    canonicalCdnUrl: z.string(),
    allowedImageHosts: z.array(z.string()),
    canonicalHostAliases: z.array(z.string()),
  }),
  metaCapi: z.object({ browserEventsEnabled: z.boolean() }),
  business: z.object({
    companyName: z.string(),
    legalName: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string(),
    city: z.string(),
    stateRegion: z.string(),
    postalCode: z.string(),
    country: z.string(),
    phone: z.string(),
    email: z.string(),
    taxId: z.string(),
  }),
  seo: z.object({
    discovery: discoverySchema,
    returnPolicy: returnPolicySchema,
  }),
});
type LayoutData = z.infer<typeof layoutDataSchema>;

// GET /storefront/homepage — consolidated homepage data
const homepageRoute = createRoute({
  method: "get",
  path: "/homepage",
  operationId: "storefront.homepage.get",
  tags: ["Storefront"],
  summary: "Get consolidated homepage data (SEO, hero, collections, categories, and policy facts)",
  responses: {
    200: {
      description: "Homepage data",
      content: { "application/json": { schema: successEnvelope(homepageDataSchema) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(homepageRoute, async (c) => {
  const db = c.get("db");
  const data = await getHomepageData(db) as unknown as HomepageData;
  return ok(c, data);
});

// GET /storefront/pages/slug/:slug — consolidated CMS page render data
const pageBySlugRoute = createRoute({
  method: "get",
  path: "/pages/slug/{slug}",
  operationId: "storefront.pages.render_by_slug_alias",
  tags: ["Storefront"],
  summary: "Get CMS page content",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Page render data",
      content: { "application/json": { schema: successEnvelope(z.object({
        page: pageSchema,
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(pageBySlugRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const data = await getPageRenderData(db, slug);
  if (!data) throw new NotFoundError("Page not found");
  return ok(c, data);
});

// GET /storefront/layout — consolidated layout data
const layoutRoute = createRoute({
  method: "get",
  path: "/layout",
  operationId: "storefront.layout.get",
  tags: ["Storefront"],
  summary: "Get consolidated layout data (analytics, header, navigation, footer, currency, theme)",
  responses: {
    200: {
      description: "Layout data",
      content: { "application/json": { schema: successEnvelope(layoutDataSchema) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(layoutRoute, async (c) => {
  const db = c.get("db");
  const data = await getLayoutData(db, {
    credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY,
  }) as unknown as LayoutData;
  return ok(c, data);
});

const resolveThemePreviewRoute = createRoute({
  method: "post",
  path: "/theme-preview/resolve",
  tags: ["Storefront"],
  summary: "Resolve a short-lived storefront theme preview cookie",
  operationId: "system.storefront_theme_preview.resolve",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            token: z.string().length(52).regex(/^tpv_[A-Za-z0-9_-]{48}$/),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Preview theme snapshot",
      content: { "application/json": { schema: successEnvelope(z.object({
        theme: flexibleObjectSchema,
        draftRevision: z.number().int().positive(),
        basePublishedRevision: z.number().int().nonnegative(),
        expiresAt: z.any(),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(resolveThemePreviewRoute, async (c) => {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Referrer-Policy", "no-referrer");
  const preview = await resolveThemePreviewSession(
    c.get("db"),
    c.req.valid("json").token,
  );
  if (!preview) throw new NotFoundError("Theme preview is unavailable or expired");
  return ok(c, preview);
});

// GET /storefront/csp — returns merchant-configured CSP allowed domains
const cspRoute = createRoute({
  method: "get",
  path: "/csp",
  tags: ["Storefront"],
  summary: "Get CSP allowed domains configuration",
  responses: {
    200: {
      description: "CSP configuration",
      content: { "application/json": { schema: successEnvelope(z.object({
        cspAllowedDomains: z.string(),
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(cspRoute, async (c) => {
  const db = c.get("db");
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, "csp_allowed_domains"), eq(settings.category, "security")))
    .get();
  return ok(c, { cspAllowedDomains: row?.value || "" });
});

export { app as storefrontRoutes };
