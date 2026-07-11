// src/server/routes/storefront.ts
// Storefront API — thin HTTP layer.
// All query logic lives in src/modules/storefront/storefront.service.ts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import {
  getHomepageData,
  getLayoutData,
  getPageRenderData,
} from "@scalius/core/modules/storefront/storefront.service";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { pageSchema } from "../schemas/entities";
const app = new OpenAPIHono<{ Bindings: Env }>();

const flexibleObjectSchema = z.record(z.string(), z.any());
const homepageDataSchema = z.object({
  seo: flexibleObjectSchema,
  hero: flexibleObjectSchema,
  collections: z.array(flexibleObjectSchema.nullable()),
}).passthrough();
type HomepageData = z.infer<typeof homepageDataSchema>;

const navigationItemSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  href: z.string().optional(),
  subMenu: z.array(z.any()).optional(),
}).passthrough();
const layoutDataSchema = z.object({
  analytics: z.any(),
  header: flexibleObjectSchema,
  navigation: z.array(navigationItemSchema),
  footer: flexibleObjectSchema,
  currency: flexibleObjectSchema,
  theme: flexibleObjectSchema,
  business: flexibleObjectSchema.optional(),
  seo: flexibleObjectSchema.optional(),
}).passthrough();
type LayoutData = z.infer<typeof layoutDataSchema>;

// GET /storefront/homepage — consolidated homepage data
const homepageRoute = createRoute({
  method: "get",
  path: "/homepage",
  tags: ["Storefront"],
  summary: "Get consolidated homepage data (SEO, hero, collections + products)",
  responses: {
    200: {
      description: "Homepage data",
      content: { "application/json": { schema: successEnvelope(homepageDataSchema) } },
    },
    500: errorResponses[500],
  }
});

app.use(
  "/homepage",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:storefront:homepage:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

app.openapi(homepageRoute, async (c) => {
  const db = c.get("db");
  const data = await getHomepageData(db) as unknown as HomepageData;
  return ok(c, data);
});

// GET /storefront/pages/slug/:slug — consolidated CMS page render data
const pageBySlugRoute = createRoute({
  method: "get",
  path: "/pages/slug/{slug}",
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

app.use(
  "/pages/slug/:slug",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:storefront:page:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

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

app.use(
  "/layout",
  cacheMiddleware({ ttl: CACHE_TTLS.STANDARD, keyPrefix: "api:storefront:layout:", varyByQuery: false, methods: ["GET"] }),
);

app.openapi(layoutRoute, async (c) => {
  const db = c.get("db");
  const data = await getLayoutData(db, {
    credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY,
  }) as unknown as LayoutData;
  return ok(c, data);
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

app.use(
  "/csp",
  cacheMiddleware({ ttl: CACHE_TTLS.STANDARD, keyPrefix: "api:storefront:csp:", varyByQuery: false, methods: ["GET"] }),
);

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
