import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cacheMiddleware } from "../middleware/cache";
import { getSeoSettings } from "@scalius/core/modules/settings/site-settings.service";
import {
  SEO_RETURN_POLICY_CATEGORIES,
  SEO_RETURN_POLICY_FEES,
  SEO_RETURN_POLICY_METHODS,
} from "@scalius/shared/seo-return-policy";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { CACHE_TTLS } from "../utils/cache-ttls";
// Create an OpenAPIHono app for SEO routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    // Bump the nested namespace when the public SEO payload shape changes.
    // The broader api:seo: invalidation group still clears versioned entries.
    keyPrefix: "api:seo:v4:",
    methods: ["GET"],
  }),
);

export interface SeoSettingsData {
  siteTitle: string | null;
  homepageTitle: string | null;
  homepageMetaDescription: string | null;
  robotsTxt: string | null;
}

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
  robots: z.object({
    advertiseSitemap: z.boolean(),
  }),
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
  category: z.enum(SEO_RETURN_POLICY_CATEGORIES),
  returnWindowDays: z.number().int().min(1).max(365).nullable(),
  returnFees: z.enum(SEO_RETURN_POLICY_FEES),
  returnMethod: z.enum(SEO_RETURN_POLICY_METHODS),
  policyUrl: z.string(),
});

// GET /seo — get SEO settings
const getSeoSettingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["SEO"],
  summary: "Get SEO settings",
  responses: {
    200: {
      description: "SEO settings",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              siteTitle: z.string().nullable(),
              homepageTitle: z.string().nullable(),
              homepageMetaDescription: z.string().nullable(),
              robotsTxt: z.string().nullable(),
              discovery: discoverySchema,
              returnPolicy: returnPolicySchema,
            }),
          ),
        },
      },
    },
    500: errorResponses[500],
  },
});

app.openapi(getSeoSettingsRoute, async (c) => {
  const db = c.get("db");
  const settings = await getSeoSettings(db);
  return ok(c, settings);
});

export { app as seoRoutes };
