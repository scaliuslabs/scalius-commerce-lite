// src/server/routes/storefront.ts
// Storefront API — thin HTTP layer.
// All query logic lives in src/modules/storefront/storefront.service.ts.

import { STOREFRONT_BLOCK_TARGETS } from "@scalius/shared/plugins/storefront-protocol";
import { PLUGIN_STOREFRONT_SCRIPT_PAGES } from "@scalius/shared/plugins/manifest";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  getHomepageData,
  getLandingPageData,
  getLayoutData,
  getTemplateSectionsData,
  getPageRenderData,
  readAppComponentData,
  readPluginBlockContext,
  readThemeBrandAssets,
  type AppComponentPlacement,
  type HomepageAppSection,
} from "@scalius/core/modules/storefront";
import { activePluginInstallationsFromRows, selectActivePluginInstallations } from "@scalius/core/modules/plugins";
import type { MarketPricing } from "@scalius/core/modules/price-lists";
import {
  PLUGIN_BLOCK_PAGES,
  PLUGIN_BLOCK_TARGETS,
  PLUGIN_HOME_SECTIONS_MAX,
  PLUGIN_PAGE_BLOCKS_MAX,
  pluginSurfaceKey,
} from "@scalius/shared/plugins";
import { resolveThemePreviewSession } from "@scalius/core/modules/settings";
import { CATEGORY_NAVIGATION_LAYOUT_NODES } from "@scalius/core/modules/navigation";
import { EMPTY_PLATFORM_CONFIG } from "@scalius/shared/platform-config";
import { PRODUCT_PAGE_COPY_KEYS, type ProductPageCopyKey } from "@scalius/shared/checkout-language";
import { NotFoundError, ValidationError } from "../utils/api-error";
import {
  HOME_BRAND_LIMIT,
  HOME_MAX_CATEGORIES,
  HOME_MAX_COLLECTIONS,
  HOME_MAX_MEDIA,
  HOME_MAX_PRODUCT_LISTS,
  HOME_MAX_PROMOTIONS,
  HOME_PRODUCT_LIST_LIMIT,
  STOREFRONT_PAGE_TEMPLATES,
  homeSectionRequests,
  type HomeAppSectionRequest,
} from "@scalius/shared/storefront-theme";
import { readWorkerVersion } from "@scalius/shared/cache-generation";
import {
  MAX_STOREFRONT_BATCH_PARTS,
  STOREFRONT_BATCH_PART_PARAM,
} from "@scalius/shared/public-api-cache-routes";
import { serveStorefrontBatch } from "../storefront-batch";
import { createPublicPartReader, renderPublicRead } from "../public-read";
import { API_PART_CACHE_MODE } from "../public-cache-policy";
import { checkHashedDependencies, hasFrontierKey, readFrontierDelta } from "../cache-frontier";
import {
  CACHE_FRONTIER_CHECK_MAX_DEPS,
  CACHE_FRONTIER_MAX_CHANGES,
  isCacheDepHash,
} from "@scalius/shared/cache-frontier";

/**
 * Parts of one batch rendered at once: every part of a page (the product
 * page and the cart have five), as when each was its own invocation. Usually
 * only the page data misses; on a cold page every part does, and their D1
 * queries queue on the invocation's six connections. A lower limit
 * serialises the last parts behind the first and adds whole D1 waves.
 */
const MAX_BATCH_PART_RENDERS = MAX_STOREFRONT_BATCH_PARTS;

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { storeShapeApiSchema, storefrontSectionListApiSchema, storefrontThemeDocumentApiSchema } from "../schemas/storefront-theme";
import { optionalProductCardFacts } from "../schemas/product-card-facts";
import { marketMatrixSchema, marketPresenceQuerySchema } from "../schemas/markets";
import { assertOnlyPresenceQuery, publicMarketPresence, publicMarketPricing, publicTranslation } from "../utils/public-market";
import { readMarketMatrix } from "@scalius/core/modules/markets";
import { startMarketPricing } from "@scalius/core/modules/price-lists";
import { MARKET_SUBFOLDER_PATTERN } from "@scalius/shared/markets";
import { publicPageDetailSchema } from "../schemas/custom-fields";
import { storeTimeZoneOf } from "../utils/store-time-zone";
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
  quickAddEligible: z.boolean(),
  freeDelivery: z.boolean(),
  categoryId: z.string().nullable(),
  hasVariants: z.boolean(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
  secondaryImageUrl: z.string().nullable(),
  rating: z.object({ average: z.number(), count: z.number().int() }).nullable().openapi({
    description: "Published-review average and count; null without a published review.",
  }),
  cardFacts: optionalProductCardFacts,
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
/** A brand-wall brand: published, live, with a public product. */
const homepageBrandSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  canonicalPath: z.string().nullable(),
  logo: z.object({
    mediaId: z.string(),
    url: z.string(),
    alt: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
  }).nullable(),
});
/** A deal countdown's promotion: active, started, and ending at `endsAt` (still ahead when read). */
const homepagePromotionSchema = z.object({
  id: z.string(),
  endsAt: z.string(),
});
/**
 * What the theme's homepage shows, read from the theme alone
 * (`homeSectionRequests(theme.pages.home, theme.pages.homeMode)` in
 * @scalius/shared/storefront-theme): one product list per source (each
 * section takes its first N), the images (hero slides included), the
 * category tiles' categories, the collections sections' collections, the
 * brand wall's brands, the deal promotions and a product homepage's product.
 */
const homepageSectionsSchema = z.object({
  lists: z.array(homepageProductListSchema).max(HOME_MAX_PRODUCT_LISTS),
  media: z.array(homepageMediaSchema).max(HOME_MAX_MEDIA),
  brands: z.array(homepageBrandSchema).max(HOME_BRAND_LIMIT),
  promotions: z.array(homepagePromotionSchema).max(HOME_MAX_PROMOTIONS),
  /** The category tiles' categories that are published, in the sections' order. */
  categories: z.array(storefrontCategoryCardSchema.extend({
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    canonicalPath: z.string().nullable(),
  })).max(HOME_MAX_CATEGORIES),
  /** The collections sections' collections that are active and have products, in the sections' order. */
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
  })).max(HOME_MAX_COLLECTIONS),
  homeProduct: z.object({ id: z.string(), slug: z.string() }).nullable().openapi({
    description: "A product homepage's product while it is public (the storefront answers `/` with a redirect to its page); null for a sections homepage or a product that is not public.",
  }),
  apps: z.array(z.object({
    sectionId: z.string(),
    component: z.object({
      pluginId: z.string(),
      type: z.string(),
      values: z.record(z.string(), z.unknown()),
      media: z.array(z.object({ id: z.string(), url: z.string(), alt: z.string(), width: z.number().nullable(), height: z.number().nullable() })),
      lists: z.array(z.object({ source: z.string(), products: z.array(z.unknown()) })),
    }).openapi({
      description: "A component section: the storefront draws it at the edge with the app's storefront module, from these resolved values, images and product cards.",
    }),
  })).max(PLUGIN_HOME_SECTIONS_MAX).openapi({
    description: "The app sections to show, by section id, each a component section's data. An app section missing here renders nothing.",
  }),
  metaobjects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    entries: z.array(z.object({
      handle: z.string(),
      title: z.string(),
      fields: z.array(z.object({
        key: z.string(),
        name: z.string(),
        type: z.string(),
        value: z.unknown().openapi({ description: "The custom-field HTTP contract, as public custom fields: text, dates, URLs, colours and media ids (in media) as strings; integers and money (decimal major units of the store currency) as numbers; booleans; lists as arrays." }),
      })),
    })),
  })).optional().openapi({
    description: "The Metaobjects sections' content types (only those with storefront access) and their published entries, by definition id.",
  }),
}).openapi("StorefrontHomepageSections");
const homepageDataSchema = z.object({
  seo: z.object({
    homepageTitle: z.string().nullable(),
    homepageMetaDescription: z.string().nullable(),
  }),
  sections: homepageSectionsSchema,
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
const brandAssetSchema = z.object({
  id: z.string(),
  url: z.string(),
  alt: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
}).nullable();
/** A theme's brand images resolved (ready or trashed images; null when unset or gone). */
const brandAssetsSchema = z.object({
  logo: brandAssetSchema,
  footerLogo: brandAssetSchema,
  favicon: brandAssetSchema,
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
  navigation: z.array(navigationItemSchema),
  /**
   * The reachable category tree (published, every ancestor published, leading
   * to a public product), flat with parentId, top levels first and bounded.
   * The theme's navigation source renders it, the header menu or both.
   */
  categoryTree: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      parentId: z.string().nullable(),
      canonicalPath: z.string().nullable(),
      imageUrl: z.string().nullable(),
    })).max(CATEGORY_NAVIGATION_LAYOUT_NODES),
    truncated: z.boolean(),
  }),
  /** The footer columns: the menus placed in Navigation, in order. */
  footerMenus: z.array(z.object({
    id: z.string(),
    title: z.string(),
    links: z.array(navigationItemSchema),
  })),
  currency: z.object({
    code: z.string(),
    symbol: z.string(),
    /** ISO 4217 decimal places: prices on the wire are major units at this precision. */
    decimalPlaces: z.number().int().min(0).max(3),
    /** The backup market's price increment in minor units: percentage prices round to it exactly as checkout charges. */
    priceIncrementMinor: z.number().int().positive().max(1_000),
  }),
  /** Every active market's countries and subfolder presences: hreflang, the market selector and the page's presence. */
  markets: marketMatrixSchema,
  theme: storefrontThemeDocumentApiSchema,
  /** The published theme's brand images (logo, footer logo, tab icon). A preview carries its draft's own. */
  brand: brandAssetsSchema,
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
    /** The store's social profiles: the only social links the storefront shows. */
    socialLinks: z.array(socialLinkSchema),
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
  /** The store's IANA time zone (Settings -> Store details): buyer-facing dates are shown in it. */
  timeZone: z.string().max(64),
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
  /** Product-page copy from the active checkout language: buttons, offers, buyer inputs, fulfilment facts. */
  storefrontCopy: z.object({
    languageCode: z.string(),
    ...(Object.fromEntries(PRODUCT_PAGE_COPY_KEYS.map((key) => [key, z.string()])) as Record<
      ProductPageCopyKey,
      z.ZodString
    >),
  }),
  /**
   * Scripts of active apps whose hosts a Super Admin approved: loaded async
   * on their pages only, their hosts added to the page CSP. Never inline.
   */
  appScripts: z.array(z.object({
    pluginId: z.string(),
    src: z.string(),
    placement: z.enum(["head", "body-end"]),
    pages: z.array(z.enum(PLUGIN_STOREFRONT_SCRIPT_PAGES)),
  })),
  appExtensions: z.array(z.object({
    pluginId: z.string(),
    version: z.string(),
    source: z.enum(["bundled", "registry", "upload"]),
    release: z.string().openapi({ description: "The release's bundle SHA-256: names its storefront files (/_x/<plugin id>/<release>/) and its isolate." }),
    sections: z.array(z.string()),
    sectionSettings: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
    skins: z.array(z.object({
      id: z.string(),
      target: z.string().openapi({ description: "The unit the skin draws: header, footer, product-card, product-main, listing-main or section:<core section type>." }),
      settings: z.array(z.record(z.string(), z.unknown())),
    })),
    blocks: z.array(z.object({
      type: z.string(),
      target: z.enum(STOREFRONT_BLOCK_TARGETS),
      settings: z.array(z.record(z.string(), z.unknown())),
    })),
    islands: z.array(z.string()),
    stylesheet: z.boolean(),
    connect: z.array(z.string()),
  })).openapi({
    description: "Active apps with storefront components (docs/STOREFRONT-COMPONENTS.md): the component sections, component product blocks and skins their storefront module draws, with the settings schemas the storefront resolves, their islands, stylesheet and approved browser hosts.",
  }),
  appBlockPages: z.array(z.enum(PLUGIN_BLOCK_PAGES)).openapi({
    description: "The page groups where an active app draws a checkout or customer-account block. Only these pages read /storefront/app-blocks/{page}.",
  }),
  appServices: z.object({
    search: z.string().nullable().openapi({ description: "The search app predictive search passes as `provider` to /search; null: built-in search." }),
    address: z.object({
      id: z.string(),
      countries: z.union([z.literal("any"), z.array(z.string())]),
    }).nullable().openapi({ description: "The address autocomplete app checkout uses for these countries; null: none." }),
    signIn: z.array(z.object({ id: z.string(), name: z.string() })).openapi({
      description: "Sign-in apps the sign-in page offers (\"Continue with <name>\"), started at /customer-auth/identity/{id}/start.",
    }),
  }),
});
type LayoutData = z.infer<typeof layoutDataSchema>;

// GET /storefront/homepage — consolidated homepage data
const homepageRoute = createRoute({
  method: "get",
  path: "/homepage",
  operationId: "storefront.homepage.get",
  tags: ["Storefront"],
  summary: "Get the published theme's homepage data (SEO and what its sections show)",
  description:
    "Takes only the page's market presence (`presence`, such as `en-in`; none: the root, the backup market), whose market prices the cards: any other query string is rejected, so the cached read has one entry per presence and callers cannot choose which products it reads.",
  request: { query: marketPresenceQuerySchema },
  responses: {
    200: {
      description: "Homepage data",
      content: { "application/json": { schema: successEnvelope(homepageDataSchema) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

/**
 * A page's app sections: component sections given their settings' images and
 * products for the storefront to draw at the edge (core app-components.ts),
 * from one read of the apps.
 */
function homeAppRenderer(c: Context<{ Bindings: Env }>) {
  return async (requests: HomeAppSectionRequest[], page: { pricing: MarketPricing | null }) => {
    const db = c.get("db");
    // The active apps among these (`plg:<id>` each: an app that starts, stops or drops a type changes the answer).
    const installations = activePluginInstallationsFromRows(await selectActivePluginInstallations(db, [...new Set(requests.map((request) => request.pluginId))]));
    const components: AppComponentPlacement[] = [];
    for (const request of requests) {
      const installation = installations.get(request.pluginId);
      const section = installation?.manifest.storefront.sections.find((entry) => entry.type === request.type);
      if (!installation || !section) continue;
      // Drawn at the edge only while the approved grant covers storefront code.
      if (installation.grant?.storefrontCode === true) {
        components.push({ sectionId: request.sectionId, pluginId: request.pluginId, type: request.type, schema: section.settings, values: request.values });
      }
    }
    const data = await readAppComponentData(db, components, page.pricing);
    const bySection = new Map<string, HomepageAppSection>(data.map((each) => [each.sectionId, each] as const));
    // Document order.
    return requests.flatMap((request) => bySection.get(request.sectionId) ?? []);
  };
}

function executionContextOf(c: Context<{ Bindings: Env }>): ExecutionContext {
  try {
    return c.executionCtx as unknown as ExecutionContext;
  } catch {
    return { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {}, exports: {} } as unknown as ExecutionContext;
  }
}

app.openapi(homepageRoute, async (c) => {
  assertOnlyPresenceQuery(c.req.url, "The homepage read takes no query parameters");
  const db = c.get("db");
  const data = await getHomepageData(db, { renderApps: homeAppRenderer(c), pricing: publicMarketPricing(c) }) as unknown as HomepageData;
  return ok(c, data);
});

// GET /storefront/landing/:slug — a published landing page's sections' data
// (the storefront takes the page's sections from the layout's theme).
const landingPageRoute = createRoute({
  method: "get",
  path: "/landing/{slug}",
  operationId: "storefront.landing.get",
  tags: ["Storefront"],
  summary: "Get a published landing page: its title, description and its sections' data",
  request: { params: z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100) }), query: marketPresenceQuerySchema },
  responses: {
    200: {
      description: "Landing page and its bounded section data",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            title: z.string(),
            description: z.string(),
            sections: homepageSectionsSchema,
          })),
        },
      },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  },
});
app.openapi(landingPageRoute, async (c) => {
  assertOnlyPresenceQuery(c.req.url, "The landing page read takes no query parameters");
  const data = await getLandingPageData(c.get("db"), c.req.valid("param").slug, { renderApps: homeAppRenderer(c), pricing: publicMarketPricing(c) });
  if (!data) throw new NotFoundError("Landing page not found");
  return ok(c, { title: data.landing.title, description: data.landing.description, sections: data.sections });
});

// GET /storefront/template/:kind — a page template's sections' data (the
// sections around a product, listing, cart or CMS page's fixed part; the
// storefront takes the sections from the layout's theme).
const templateSectionsRoute = createRoute({
  method: "get",
  path: "/template/{kind}",
  operationId: "storefront.template.get",
  tags: ["Storefront"],
  summary: "Get what a page template's sections show",
  description:
    "The published theme's sections around the fixed part of every product, collection, cart or CMS page: their product lists, images and the rest, like a landing page's. Takes only the page's market presence; a template without sections answers empty sections.",
  request: { params: z.object({ kind: z.enum(STOREFRONT_PAGE_TEMPLATES) }), query: marketPresenceQuerySchema },
  responses: {
    200: {
      description: "The template's section data",
      content: { "application/json": { schema: successEnvelope(z.object({ sections: homepageSectionsSchema })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});
app.openapi(templateSectionsRoute, async (c) => {
  assertOnlyPresenceQuery(c.req.url, "The template read takes no query parameters");
  const sections = await getTemplateSectionsData(c.get("db"), c.req.valid("param").kind, { renderApps: homeAppRenderer(c), pricing: publicMarketPricing(c) });
  return ok(c, { sections });
});

// GET /storefront/extensions/:pluginId/:release?path= — an app's storefront file
const extensionFileRoute = createRoute({
  method: "get",
  path: "/extensions/{pluginId}/{release}",
  operationId: "storefront.extension_file.get",
  tags: ["Storefront"],
  summary: "Read one storefront file of an installed app's current release",
  description:
    "The storefront module, stylesheet, an island or a public file (font, image) of an app's current release, checked against the digests sealed into its signed bundle. Immutable: a release's file never changes, so it is cached for a year. The storefront serves it on its own origin at /_x/<plugin id>/<release>/<path>. Bundled apps' files are compiled into the storefront and are not served here.",
  request: {
    params: z.object({
      pluginId: z.string().max(100),
      release: z.string().regex(/^[0-9a-f]{64}$/).openapi({ description: "The release's bundle SHA-256 (the layout's appExtensions[].release)." }),
    }),
    query: z.object({ path: z.string().max(200).openapi({ description: "storefront.js, styles.css, islands/<name>.js or public/<path>." }) }),
  },
  responses: {
    200: {
      description: "The file",
      content: {
        "text/javascript": { schema: z.string() },
        "text/css": { schema: z.string() },
        "font/woff2": { schema: z.string().openapi({ format: "binary" }) },
        "image/svg+xml": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    404: errorResponses[404],
  },
});
app.openapi(extensionFileRoute, async (c) => {
  const { pluginId, release } = c.req.valid("param");
  const { readPluginStorefrontFile } = await import("../plugins/storefront-files");
  const file = await readPluginStorefrontFile(c.env, c.get("db"), pluginId, release, c.req.valid("query").path);
  if (!file) {
    return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "File not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }) as never;
  }
  return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      ...(file.contentType === "image/svg+xml" ? { "Content-Security-Policy": "sandbox" } : {}),
    },
  }) as never;
});

// GET /storefront/app-blocks/:page — the checkout or customer-account app blocks
const appBlocksRoute = createRoute({
  method: "get",
  path: "/app-blocks/{page}",
  operationId: "storefront.app_blocks.get",
  tags: ["Storefront"],
  summary: "Get the app blocks a checkout, order or account page shows",
  description:
    "Every active app's blocks for one page group (checkout, order, account), drawn by the app at its Shopify-style extension target: sanitized HTML with no scripts, the same for every buyer. Read it only when the layout's appBlockPages lists the page. Takes no query; cached under dependency validation (each app's installation and declared storage), so a cached answer runs no app code.",
  request: { params: z.object({ page: z.enum(PLUGIN_BLOCK_PAGES) }) },
  responses: {
    200: {
      description: "The drawn blocks, in app id then manifest order",
      content: { "application/json": { schema: successEnvelope(z.object({
        blocks: z.array(z.object({
          id: z.string().openapi({ description: "<app id>/<block type>" }),
          app: z.string(),
          target: z.enum(PLUGIN_BLOCK_TARGETS),
          html: z.string().openapi({ description: "Sanitized HTML. Checkout blocks hold no forms." }),
        })).max(PLUGIN_PAGE_BLOCKS_MAX),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});
app.openapi(appBlocksRoute, async (c) => {
  if (new URL(c.req.url).search) throw new ValidationError("The app blocks read takes no query parameters");
  const db = c.get("db");
  const context = await readPluginBlockContext(db, c.req.valid("param").page);
  if (context.requests.length === 0) return ok(c, { blocks: [] });
  const { renderAppBlocks } = await import("../plugins/storefront-render");
  const drawn = await renderAppBlocks(context.requests, {
    env: c.env,
    ctx: executionContextOf(c),
    db,
    context: { installations: context.installations, store: context.store },
  });
  return ok(c, {
    blocks: drawn.map((each) => ({ id: pluginSurfaceKey(each.pluginId, each.type), app: each.pluginId, target: each.target, html: each.html })),
  });
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
        page: publicPageDetailSchema,
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(pageBySlugRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const data = await getPageRenderData(db, slug, publicTranslation(c));
  if (!data) throw new NotFoundError("Page not found");
  return ok(c, data);
});

// GET /storefront/layout — consolidated layout data
const layoutRoute = createRoute({
  method: "get",
  path: "/layout",
  operationId: "storefront.layout.get",
  tags: ["Storefront"],
  summary: "Get consolidated layout data (analytics, navigation, footer menus, currency, theme and its brand images, business identity)",
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
  const read = () => getLayoutData(db, {
    credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY,
    // A presence's menus, category tree, policies and copy in its language (MARKETS-DESIGN D9).
    presence: publicMarketPresence(c) || null,
  });
  let layout = await read();
  // Right after a deploy, a bundled app's installation can still name the
  // release before it, whose storefront files the new storefront no longer
  // has: bring it in step now (the sync keeps an app that asks for more
  // access waiting for approval) instead of on the next Apps page visit or tick.
  const stale = await staleBundledStorefronts(layout.appExtensions);
  if (stale.length > 0) {
    const { syncBundledPlugin } = await import("../plugins/bundled-sync");
    for (const pluginId of stale) await syncBundledPlugin(db, pluginId).catch(() => null);
    layout = await read();
  }
  const platform = c.env.PLATFORM_CONFIG ?? EMPTY_PLATFORM_CONFIG;
  return ok(c, {
    ...layout,
    platform: {
      storefrontUrl: platform.storefrontUrl,
      apiUrl: platform.apiUrl,
      dashboardUrl: platform.dashboardUrl,
      mediaUrl: platform.mediaUrl,
    },
    // From the tracked platform row inside a dependency scope, so a saved
    // time zone advances this page's `set:platform:document` dependency.
    timeZone: storeTimeZoneOf(c.env),
  } as unknown as LayoutData);
});

/** Bundled apps the layout lists at another release than this deployment compiled in. */
async function staleBundledStorefronts(extensions: unknown): Promise<string[]> {
  const listed = Array.isArray(extensions) ? extensions as Array<{ pluginId?: unknown; source?: unknown; release?: unknown }> : [];
  const bundled = listed.filter((extension) => extension.source === "bundled");
  if (bundled.length === 0) return [];
  const { BUNDLED_PLUGINS } = await import("../plugins/bundled.gen");
  return bundled.flatMap((extension) => {
    const id = typeof extension.pluginId === "string" ? extension.pluginId : "";
    const entry = Object.prototype.hasOwnProperty.call(BUNDLED_PLUGINS, id) ? BUNDLED_PLUGINS[id] : undefined;
    return entry && entry.sha256 !== extension.release ? [id] : [];
  });
}

// GET /storefront/markets — the active presence matrix (the storefront
// gateway resolves a buyer's market choice with it; pages read it in the layout)
const marketsRoute = createRoute({
  method: "get",
  path: "/markets",
  operationId: "storefront.markets.get",
  tags: ["Storefront"],
  summary: "Get the active markets with their countries and URL presences",
  description: "Every active market, backup first: the countries it sells to and its subfolder presences (`/en-in`). The root URL is the backup market's. Draft markets are left out.",
  responses: {
    200: {
      description: "The active presence matrix",
      content: { "application/json": { schema: successEnvelope(marketMatrixSchema) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(marketsRoute, async (c) => ok(c, await readMarketMatrix(c.get("db"))));

// GET /storefront/batch — one storefront page render's public reads
const batchPartSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  body: z.string().openapi({ description: "The part's response body, exactly as its own GET returns it" }),
  cache: z.object({
    apiVersion: z.string().min(1),
    status: z.enum(["hit", "miss", "refresh"]),
    s0: z.number().int(),
    deps: z.array(z.string()),
    validUntil: z.number().nullable(),
    softMaxAgeSeconds: z.number().nullable(),
    renderedAt: z.number(),
  }).optional().openapi({
    description: "Dependency-validated cache proof of the part (hashed dependency keys and the change-clock value it is fresh at), for the storefront page cache. Absent when the part carries no proof.",
  }),
});
const batchRoute = createRoute({
  method: "get",
  path: "/batch",
  operationId: "storefront.batch.get",
  tags: ["Storefront"],
  summary: "Read several public storefront resources in one request",
  description:
    `Answers each \`${STOREFRONT_BATCH_PART_PARAM}\` part (the /api/v1 path and query of a public, dependency-validated read such as the layout, a product, shipping methods or checkout settings) exactly as its own GET would, in order, from the same dependency-validated cache. At most ${MAX_STOREFRONT_BATCH_PARTS} parts and no cookies or credentials. The storefront renders each page from one batch. The batch itself is never cached; its parts are, and a failed part fails only that part.`,
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
  // Parts are served inside this invocation: the data center's Cache API,
  // else rendered here by the same renderPublicRead path as direct reads.
  const reader = createPublicPartReader({
    mode: API_PART_CACHE_MODE,
    env: c.env,
    cache: typeof caches === "undefined" ? null : caches.default,
    db: () => c.get("db"),
    render: (part) => renderPublicRead(part, c.env, ctx as ExecutionContext),
    waitUntil: (promise) => ctx?.waitUntil(promise),
    maxConcurrentRenders: MAX_BATCH_PART_RENDERS,
  });
  const response = await serveStorefrontBatch(request, {
    readGeneration: async () => null,
    readParts: (parts, generation) => reader.readParts(parts, generation),
  });
  return response as never;
});

// GET /storefront/frontier and POST /storefront/frontier/check: the
// dependency-validated cache's change frontier for the storefront page cache
// (CACHE-DESIGN §6.7). Internal: authenticated with the storefront's frontier
// key (HKDF of SCALIUS_SECRET), never cached, not part of the public contract.
const frontierHeaders = { "Cache-Control": "private, no-store" } as const;
const frontierDenied = () => Response.json({ success: false, error: "Not found" }, { status: 404, headers: frontierHeaders });
const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

app.get("/frontier", async (c) => {
  if (!(await hasFrontierKey(c.req.raw, c.env))) return frontierDenied();
  const apiVersion = readWorkerVersion(c.env);
  if (!apiVersion) return Response.json({ success: false, error: "Cache proof unavailable" }, { status: 503, headers: frontierHeaders });
  const url = new URL(c.req.url);
  const since = url.searchParams.has("since") ? nonNegativeInteger(Number(url.searchParams.get("since"))) : null;
  if (url.searchParams.has("since") && since === null) {
    return Response.json({ success: false, error: "since must be a clock value" }, { status: 400, headers: frontierHeaders });
  }
  const limit = nonNegativeInteger(Number(url.searchParams.get("limit") ?? CACHE_FRONTIER_MAX_CHANGES)) ?? CACHE_FRONTIER_MAX_CHANGES;
  const delta = await readFrontierDelta(c.get("db"), since, Math.max(1, limit));
  return Response.json({ success: true, data: { ...delta, apiVersion } }, { headers: frontierHeaders });
});

app.post("/frontier/check", async (c) => {
  if (!(await hasFrontierKey(c.req.raw, c.env))) return frontierDenied();
  const apiVersion = readWorkerVersion(c.env);
  if (!apiVersion) return Response.json({ success: false, error: "Cache proof unavailable" }, { status: 503, headers: frontierHeaders });
  const input = await c.req.json().catch(() => null) as { s0?: unknown; deps?: unknown } | null;
  const s0 = nonNegativeInteger(input?.s0);
  const hashes = Array.isArray(input?.deps) ? input!.deps as unknown[] : null;
  if (s0 === null || !hashes || hashes.length > CACHE_FRONTIER_CHECK_MAX_DEPS || !hashes.every(isCacheDepHash)) {
    return Response.json({ success: false, error: "Invalid frontier check" }, { status: 400, headers: frontierHeaders });
  }
  const result = await checkHashedDependencies(c.get("db"), s0, hashes as string[]);
  return Response.json({ success: true, data: { ...result, apiVersion } }, { headers: frontierHeaders });
});

const resolveThemePreviewRoute = createRoute({
  method: "post",
  path: "/theme-preview/resolve",
  tags: ["Storefront"],
  summary: "Resolve a short-lived storefront theme preview cookie to the current saved draft",
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
      description: "The saved draft as it is now, with its brand images",
      content: { "application/json": { schema: successEnvelope(z.object({
        theme: storefrontThemeDocumentApiSchema,
        brand: brandAssetsSchema,
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
  const db = c.get("db");
  const preview = await resolveThemePreviewSession(db, c.req.valid("json").token);
  if (!preview) throw new NotFoundError("Theme preview is unavailable or expired");
  return ok(c, { ...preview, brand: await readThemeBrandAssets(db, preview.theme.brand) });
});

// POST /storefront/theme-preview/homepage — the draft's homepage section data
const themePreviewHomepageRoute = createRoute({
  method: "post",
  path: "/theme-preview/homepage",
  tags: ["Storefront"],
  summary: "Read the homepage section data of a theme preview's draft",
  description:
    "What a draft page's sections show (product lists, images and hero slides, category tiles, collections, brands, deal promotions and a product homepage's product), for the storefront preview behind a live preview cookie. The reads come from the current saved draft, or from `sections`: the theme editor's unsaved sections of the page, validated with the same section schema. Only a live preview token (a staff preview session) is answered; the answer is private and never cached. `presence` prices the lists in that market.",
  operationId: "system.storefront_theme_preview.homepage",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            token: z.string().length(52).regex(/^tpv_[A-Za-z0-9_-]{48}$/),
            pageSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).optional(),
            /** A page template's sections (`pages.templates[template]`) instead of the homepage's. */
            template: z.enum(STOREFRONT_PAGE_TEMPLATES).optional(),
            /** The editor's unsaved sections of the page, instead of the saved draft's. */
            sections: storefrontSectionListApiSchema.optional(),
            /** The previewed market presence (`en-in`); none: the root. */
            presence: z.string().regex(MARKET_SUBFOLDER_PATTERN).optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The draft's homepage section data",
      content: { "application/json": { schema: successEnvelope(homepageSectionsSchema) } },
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
  const { pageSlug, template, sections, presence } = c.req.valid("json");
  const landing = pageSlug ? preview.theme.pages.landing[pageSlug] : null;
  if (pageSlug && !landing && !sections) throw new NotFoundError("Landing page not found");
  const requests = sections
    ? homeSectionRequests(sections, pageSlug || template ? { kind: "sections" } : preview.theme.pages.homeMode)
    : template
      ? homeSectionRequests(preview.theme.pages.templates[template].sections, { kind: "sections" })
      : landing
        ? homeSectionRequests(landing.sections, { kind: "sections" })
        : homeSectionRequests(preview.theme.pages.home, preview.theme.pages.homeMode);
  // A draft's app sections are drawn live (this answer is never cached).
  const data = (await getHomepageData(db, {
    requests,
    renderApps: homeAppRenderer(c),
    pricing: presence ? startMarketPricing(db, presence) : null,
  })).sections;
  return ok(c, data as unknown as HomepageData["sections"]);
});

export { app as storefrontRoutes };
