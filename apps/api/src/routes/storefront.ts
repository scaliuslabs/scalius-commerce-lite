// src/server/routes/storefront.ts
// Storefront API — thin HTTP layer.
// All query logic lives in src/modules/storefront/storefront.service.ts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getHomepageData, getLayoutData, getPageRenderData } from "@scalius/core/modules/storefront";
import { resolveThemePreviewSession } from "@scalius/core/modules/settings";
import { EMPTY_PLATFORM_CONFIG } from "@scalius/shared/platform-config";
import { NotFoundError, ValidationError } from "../utils/api-error";
import {
  HOME_MAX_MEDIA,
  HOME_MAX_PRODUCT_LISTS,
  HOME_PRODUCT_LIST_LIMIT,
  homeSectionRequests,
} from "@scalius/shared/storefront-theme";
import {
  CACHE_GENERATION_HEADER,
  normalizeCacheGeneration,
} from "@scalius/shared/cache-generation";
import {
  MAX_STOREFRONT_BATCH_PARTS,
  STOREFRONT_BATCH_PART_PARAM,
} from "@scalius/shared/public-api-cache-routes";
import { serveStorefrontBatch } from "../storefront-batch";
import { createLocalPublicReader, renderPublicRead } from "../public-read";

/**
 * Parts of one batch rendered at once: every part of a page (layout, page
 * data, shipping, checkout settings), as when each was its own invocation.
 * Usually only the page data misses; right after a generation bump all four
 * do, and their D1 queries queue on the invocation's six connections. A
 * lower limit would serialise the parts and add whole D1 waves instead.
 */
const MAX_BATCH_PART_RENDERS = 4;
import { readCacheGeneration } from "../utils/cache-generation";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { pageSchema } from "../schemas/entities";
import { storeShapeApiSchema, storefrontThemeDocumentApiSchema } from "../schemas/storefront-theme";
const app = new OpenAPIHono<{ Bindings: Env }>();

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
  secondaryImageUrl: z.string().nullable(),
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
const homepageProductListSchema = z.object({
  /** `storefrontProductSourceKey(source)`: newest, on-sale, popular, collection:<id>, category:<id>. */
  key: z.string(),
  products: z.array(storefrontProductCardSchema).max(HOME_PRODUCT_LIST_LIMIT),
  /** The category a category list reads (published categories only). */
  category: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    canonicalPath: z.string().nullable(),
  }).nullable(),
  /** The collection a collection list reads (active collections only). */
  collection: z.object({ id: z.string(), title: z.string() }).nullable(),
});
const homepageMediaSchema = z.object({
  id: z.string(),
  url: z.string(),
  alt: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
const homepageDataSchema = z.object({
  seo: z.object({
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
    }),
  }),
  /**
   * What the theme's homepage sections show: one product list per source
   * (each section takes its first N) and the section images, in request
   * order (`homeSectionRequests` in @scalius/shared/storefront-theme).
   */
  sections: z.object({
    lists: z.array(homepageProductListSchema).max(HOME_MAX_PRODUCT_LISTS),
    media: z.array(homepageMediaSchema).max(HOME_MAX_MEDIA),
  }),
});
type HomepageData = z.infer<typeof homepageDataSchema>;

const navigationLeafSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  href: z.string().optional(),
  imageUrl: z.string().optional(),
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
  feeds: z.object({
    productCatalogEnabled: z.boolean(),
    includeUnavailableProducts: z.boolean(),
    variantStrategy: z.enum(["products", "variants"]),
    title: z.string(),
    description: z.string(),
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
  theme: storefrontThemeDocumentApiSchema,
  storeShape: storeShapeApiSchema,
  media: z.object({
    canonicalCdnUrl: z.string(),
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
    /** Default og:image: "" or an absolute https URL. */
    socialImage: z.string(),
  }),
  /** Public origins of this deployment, so the storefront needs no separate platform read. */
  platform: z.object({
    storefrontUrl: z.string(),
    apiUrl: z.string(),
    dashboardUrl: z.string(),
    mediaUrl: z.string(),
  }),
  /** Merchant CSP sources (Settings -> Security), comma-separated. */
  cspAllowedDomains: z.string(),
  /**
   * Store policies linked in Settings -> Policies whose pages are published,
   * in this order: refund, privacy, terms, shipping, contact. For the footer
   * and checkout; `path` is a same-store page path such as /refund-policy.
   */
  policies: z.array(z.object({
    kind: z.enum(["refund", "privacy", "terms", "shipping", "contact"]),
    title: z.string(),
    path: z.string(),
  })),
  /** Product call-to-action copy from the active checkout language. */
  storefrontCopy: z.object({
    languageCode: z.string(),
    addToCartText: z.string(),
    buyNowText: z.string(),
    unavailableText: z.string(),
    chooseOptionText: z.string(),
    fromPriceText: z.string(),
    quantityLabelText: z.string(),
    quantityLimitText: z.string(),
    saleOfferText: z.string(),
    saleOfferSpendText: z.string(),
    saleOfferGetText: z.string(),
    saleOfferGetSpendText: z.string(),
    freeBenefitText: z.string(),
    percentBenefitText: z.string(),
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
  description:
    "Takes no parameters: a query string is rejected, so the generation-cached read has exactly one cache entry and callers cannot choose which products it reads.",
  responses: {
    200: {
      description: "Homepage data",
      content: { "application/json": { schema: successEnvelope(homepageDataSchema) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(homepageRoute, async (c) => {
  if (new URL(c.req.url).search) throw new ValidationError("The homepage read takes no query parameters");
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
  const layout = await getLayoutData(db, {
    credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY,
  });
  const platform = c.env.PLATFORM_CONFIG ?? EMPTY_PLATFORM_CONFIG;
  return ok(c, {
    ...layout,
    platform: {
      storefrontUrl: platform.storefrontUrl,
      apiUrl: platform.apiUrl,
      dashboardUrl: platform.dashboardUrl,
      mediaUrl: platform.mediaUrl,
    },
  } as unknown as LayoutData);
});

// GET /storefront/batch — one storefront page render's public reads
const batchPartSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  body: z.string().openapi({ description: "The part's response body, exactly as its own GET returns it" }),
});
const batchRoute = createRoute({
  method: "get",
  path: "/batch",
  operationId: "storefront.batch.get",
  tags: ["Storefront"],
  summary: "Read several public storefront resources in one request",
  description:
    `Answers each \`${STOREFRONT_BATCH_PART_PARAM}\` part (the /api/v1 path and query of a public, generation-cached read such as the layout, a product, shipping methods or checkout settings) exactly as its own GET would, in order, from the same generation-keyed cache. At most ${MAX_STOREFRONT_BATCH_PARTS} parts and no cookies or credentials. The storefront renders each page from one batch. The batch itself is never cached; its parts are, and a failed part fails only that part.`,
  request: {
    query: z.object({
      [STOREFRONT_BATCH_PART_PARAM]: z.union([
        z.string().max(2_048),
        z.array(z.string().max(2_048)).max(MAX_STOREFRONT_BATCH_PARTS),
      ]).openapi({ description: "Part path and query, repeated once per part" }),
    }),
  },
  responses: {
    200: {
      description: "Each part's status and body, in request order",
      content: { "application/json": { schema: successEnvelope(z.object({ parts: z.array(batchPartSchema) })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(batchRoute, async (c) => {
  const request = c.req.raw;
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx as ExecutionContext;
  } catch {
    ctx = undefined;
  }
  // Parts are served inside this invocation: the data center's Cache API
  // under the key the PublicApi cache uses (publicReadCacheKey), else
  // rendered here exactly as PublicApi renders them (renderPublicRead). A
  // PublicApi miss would instead wait for a separate, usually cold, isolate.
  const readPart = createLocalPublicReader({
    env: c.env,
    cache: typeof caches === "undefined" ? null : caches.default,
    render: (part) => renderPublicRead(part, c.env, ctx as ExecutionContext),
    waitUntil: (promise) => ctx?.waitUntil(promise),
    maxConcurrentRenders: MAX_BATCH_PART_RENDERS,
  });
  const response = await serveStorefrontBatch(request, {
    // A render pins its reads to its page's generation. Generations are
    // unguessable, so a caller-supplied one can only select existing entries.
    readGeneration: async () =>
      normalizeCacheGeneration(request.headers.get(CACHE_GENERATION_HEADER))
      ?? await readCacheGeneration(c.env, ctx),
    fetchPart: readPart,
  });
  return response as never;
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
        theme: storefrontThemeDocumentApiSchema,
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

// POST /storefront/theme-preview/homepage — the draft's homepage section data
const themePreviewHomepageRoute = createRoute({
  method: "post",
  path: "/theme-preview/homepage",
  tags: ["Storefront"],
  summary: "Read the homepage section data of a theme preview's draft",
  description:
    "The product lists and images the draft theme's homepage sections show, for the storefront preview behind a live preview cookie. The reads come from the stored draft, never from the caller, and the answer is private and never cached.",
  operationId: "system.storefront_theme_preview.homepage",
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
      description: "The draft's homepage section data",
      content: { "application/json": { schema: successEnvelope(homepageDataSchema.shape.sections) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(themePreviewHomepageRoute, async (c) => {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Referrer-Policy", "no-referrer");
  const db = c.get("db");
  const preview = await resolveThemePreviewSession(db, c.req.valid("json").token);
  if (!preview) throw new NotFoundError("Theme preview is unavailable or expired");
  const requests = homeSectionRequests(preview.theme.pages.home);
  const data = requests.lists.length > 0 || requests.mediaIds.length > 0
    ? (await getHomepageData(db, { requests, sectionsOnly: true })).sections
    : { lists: [], media: [] };
  return ok(c, data as unknown as HomepageData["sections"]);
});

export { app as storefrontRoutes };
