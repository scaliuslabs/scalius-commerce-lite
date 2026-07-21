import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getKv } from "../../../utils/kv-cache";
import {
  invalidateSiteSettingsCache,
  invalidateStorefrontUrlCache,
} from "@scalius/core/modules/settings";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";
import {
  STOREFRONT_THEME_BODY_FONTS,
  STOREFRONT_THEME_BUTTON_STYLES,
  STOREFRONT_THEME_CARD_STYLES,
  STOREFRONT_THEME_CONTAINER_WIDTHS,
  STOREFRONT_THEME_CORNER_STYLES,
  STOREFRONT_THEME_DENSITIES,
  STOREFRONT_THEME_HEADING_FONTS,
  STOREFRONT_THEME_INPUT_STYLES,
  STOREFRONT_THEME_TYPE_SCALES,
  listInvalidStorefrontThemeSettingsEntries,
} from "@scalius/shared/storefront-theme";
import {
  SUPPORTED_CURRENCY_CODES,
} from "@scalius/shared/currency";
import {
  SEO_RETURN_POLICY_CATEGORIES,
  SEO_RETURN_POLICY_FEES,
  SEO_RETURN_POLICY_METHODS,
  isValidSeoReturnPolicyUrl,
} from "@scalius/shared/seo-return-policy";
import {
  MAX_HOMEPAGE_CATEGORY_IDS,
  MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH,
} from "@scalius/shared/homepage-presentation";
import {
  HEADER_LOGO_WIDTH_DEFAULT,
  HEADER_LOGO_WIDTH_MAX,
  HEADER_LOGO_WIDTH_MIN,
  HEADER_LOGO_WIDTH_STEP,
} from "@scalius/shared/brand-presentation";
import {
  getCurrencySettings,
  isCurrencyCodeLocked,
  saveCurrencySettings,
  getGeneralSettings,
  saveHeaderConfig,
  saveFooterConfig,
  getThemeSettings,
  getThemeWorkspace,
  saveThemeDraft,
  rebaseThemeDraft,
  publishThemeDraft,
  listThemeVersions,
  rollbackThemeSettings,
  createThemePreviewSession,
  saveThemeSettings,
  getMediaOptimizationSettings,
  isValidMediaHostInput,
  saveMediaOptimizationSettings,
  getSeoSettings,
  saveSeoSettings,
  getStorefrontUrlSetting,
  saveStorefrontUrl,
  getHomepagePresentationSettings,
  saveHomepagePresentationSettings,
  getAllowedCountries,
  saveAllowedCountries,
} from "@scalius/core/modules/settings/site-settings.service";
import {
  PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT,
  PRODUCT_FEED_DIAGNOSTIC_MAX_SCAN_LIMIT,
  PRODUCT_FEED_DIAGNOSTIC_REASONS,
  getProductFeedDiagnostics,
} from "@scalius/core/modules/products";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";

import { ok } from "../../../utils/api-response";
import {
  successEnvelope,
  messageResponse,
  errorResponses,
  conflictResponse,
} from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const LAYOUT_CACHE_GROUPS = ["layout"] as const;
const HOMEPAGE_CACHE_GROUPS = ["homepage"] as const;
const DISCOVERY_CACHE_GROUPS = ["discovery"] as const;
const STOREFRONT_URL_CACHE_GROUPS = [
  ...HOMEPAGE_CACHE_GROUPS,
  ...LAYOUT_CACHE_GROUPS,
  ...DISCOVERY_CACHE_GROUPS,
] as const;
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const CURRENCY_CACHE_GROUPS = ["layout", "checkout"] as const;
const MEDIA_CACHE_GROUPS = ["media"] as const;
const SEO_DISCOVERY_WARM_PATHS = [
  "/",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemap-static.xml",
  "/sitemap-categories.xml",
  "/sitemap-collections.xml",
  "/sitemap-pages.xml",
  "/sitemap-products.xml?page=1",
  "/api/product-feed.xml",
  "/api/facebook-feed.xml",
] as const;

async function deleteLegacyCurrencyGatewayCache(kv?: KVNamespace | null): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete("gw:currency");
  } catch (error: unknown) {
    console.warn(
      "[Settings] Legacy KV delete failed for gw:currency:",
      error instanceof Error ? error.message : error,
    );
  }
}

// ─────────────────────────────────────────
// CURRENCY
// ─────────────────────────────────────────

const supportedCurrencyCodeSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toUpperCase() : value,
  z.enum(SUPPORTED_CURRENCY_CODES, {
    error: "Select a supported three-letter currency code.",
  }),
);

const currencySettingsSchema = z.object({
  currencyCode: z.enum(SUPPORTED_CURRENCY_CODES),
  currencySymbol: z.string(),
  usdExchangeRate: z.string(),
  currencyCodeLocked: z.boolean(),
});

const getCurrencyRoute = createRoute({
  method: "get",
  path: "/currency",
  tags: ["Admin - Settings"],
  summary: "Get currency settings",
  responses: {
    200: {
      description: "Currency settings",
      content: {
        "application/json": { schema: successEnvelope(currencySettingsSchema) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getCurrencyRoute, async (c) => {
  const db = c.get("db");
  const result = await getCurrencySettings(db);
  const currencyCodeLocked = await isCurrencyCodeLocked(db);
  return ok(c, { ...result, currencyCodeLocked });
});

const saveCurrencySchema = z.object({
  currencyCode: supportedCurrencyCodeSchema.optional(),
  currencySymbol: z.string().optional(),
  usdExchangeRate: z
    .string()
    .trim()
    .refine((value) => {
      const rate = Number(value);
      return value.length > 0 && Number.isFinite(rate) && rate > 0;
    }, "USD exchange rate must be a finite number greater than 0.")
    .optional(),
});

const saveCurrencyRoute = createRoute({
  method: "post",
  path: "/currency",
  tags: ["Admin - Settings"],
  summary: "Save currency settings",
  request: {
    body: { content: { "application/json": { schema: saveCurrencySchema } } },
  },
  responses: {
    200: {
      description: "Settings saved",
      content: { "application/json": { schema: messageResponse } },
    },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(saveCurrencyRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  await saveCurrencySettings(db, body);

  const kv = getKv();
  await deleteLegacyCurrencyGatewayCache(kv);
  await invalidateApiAndScheduleStorefrontGroups(CURRENCY_CACHE_GROUPS, c);

  return ok(c, { message: "Currency settings saved successfully" });
});

// ─────────────────────────────────────────
// GENERAL (header + footer config)
// ─────────────────────────────────────────

const navigationConfigReadinessSchema = z.object({
  state: z.enum(["ready", "legacy_normalized", "invalid"]),
  message: z.string().optional(),
});

const getGeneralRoute = createRoute({
  method: "get",
  path: "/general",
  tags: ["Admin - Settings"],
  summary: "Get general settings (header + footer config)",
  responses: {
    200: {
      description: "General settings",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              headerConfig: z.record(z.string(), z.unknown()),
              footerConfig: z.record(z.string(), z.unknown()),
              revisions: z.object({
                header: z.number().int().nonnegative(),
                footer: z.number().int().nonnegative(),
              }),
              navigationReadiness: z.object({
                header: navigationConfigReadinessSchema,
                footer: navigationConfigReadinessSchema,
              }),
            }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getGeneralRoute, async (c) => {
  const db = c.get("db");
  const result = await getGeneralSettings(db);
  return ok(c, result);
});

// ─────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────
const socialLinkSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  iconUrl: z.string().optional(),
});
const headerLogoWidthSchema = z.number().int()
  .min(HEADER_LOGO_WIDTH_MIN)
  .max(HEADER_LOGO_WIDTH_MAX)
  .multipleOf(HEADER_LOGO_WIDTH_STEP);
const headerConfigSchema = z.object({
  topBar: z.object({
    text: z.string(),
    isEnabled: z.boolean().optional().default(true),
  }),
  logo: z.object({
    src: z.string(),
    alt: z.string(),
    width: headerLogoWidthSchema.optional().default(HEADER_LOGO_WIDTH_DEFAULT),
  }),
  favicon: z.object({ src: z.string(), alt: z.string() }),
  contact: z.object({
    phone: z.string(),
    text: z.string(),
    isEnabled: z.boolean().optional().default(true),
  }),
  social: z.array(socialLinkSchema),
});

const saveHeaderSchema = headerConfigSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});

const saveHeaderRoute = createRoute({
  method: "post",
  path: "/header",
  tags: ["Admin - Settings"],
  summary: "Save header configuration",
  request: {
    body: { content: { "application/json": { schema: saveHeaderSchema } } },
  },
  responses: {
    200: {
      description: "Header saved",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            revision: z.number().int().positive(),
          })),
        },
      },
    },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(saveHeaderRoute, async (c) => {
  const db = c.get("db");
  const { expectedRevision, ...validatedConfig } = c.req.valid("json");
  const saved = await saveHeaderConfig(
    db,
    validatedConfig as unknown as Record<string, unknown>,
    expectedRevision,
  );
  await invalidateSiteSettingsCache(getKv());
  await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
  return ok(c, saved);
});

// ─────────────────────────────────────────
// FOOTER
// ─────────────────────────────────────────
const footerConfigSchema = z.object({
  logo: z.object({ src: z.string(), alt: z.string() }),
  tagline: z.string().optional().default(""),
  description: z.string().optional().default(""),
  copyrightText: z.string().optional().default(""),
  social: z.array(socialLinkSchema),
});

const saveFooterSchema = footerConfigSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});

const saveFooterRoute = createRoute({
  method: "post",
  path: "/footer",
  tags: ["Admin - Settings"],
  summary: "Save footer configuration",
  request: {
    body: { content: { "application/json": { schema: saveFooterSchema } } },
  },
  responses: {
    200: {
      description: "Footer saved",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            revision: z.number().int().positive(),
          })),
        },
      },
    },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(saveFooterRoute, async (c) => {
  const db = c.get("db");
  const { expectedRevision, ...validatedConfig } = c.req.valid("json");
  const saved = await saveFooterConfig(
    db,
    validatedConfig as unknown as Record<string, unknown>,
    expectedRevision,
  );
  await invalidateSiteSettingsCache(getKv());
  await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
  return ok(c, saved);
});

// ─────────────────────────────────────────
// THEME
// ─────────────────────────────────────────

const themeDocumentSchema = z
  .object({
    colors: z.record(z.string(), z.string()),
    typography: z.object({
      heading: z.enum(STOREFRONT_THEME_HEADING_FONTS),
      body: z.enum(STOREFRONT_THEME_BODY_FONTS),
      scale: z.enum(STOREFRONT_THEME_TYPE_SCALES),
    }).strict(),
    cornerStyle: z.enum(STOREFRONT_THEME_CORNER_STYLES),
    density: z.enum(STOREFRONT_THEME_DENSITIES),
    containerWidth: z.enum(STOREFRONT_THEME_CONTAINER_WIDTHS),
    components: z.object({
      buttons: z.enum(STOREFRONT_THEME_BUTTON_STYLES),
      inputs: z.enum(STOREFRONT_THEME_INPUT_STYLES),
      cards: z.enum(STOREFRONT_THEME_CARD_STYLES),
    }).strict(),
  })
  .strict()
  .superRefine((theme, ctx) => {
    const invalidEntries = listInvalidStorefrontThemeSettingsEntries(theme);
    if (invalidEntries.length === 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid theme settings: ${invalidEntries.join(", ")}`,
    });
  });

const getThemeRoute = createRoute({
  method: "get",
  path: "/theme",
  tags: ["Admin - Settings"],
  summary: "Get theme settings",
  responses: {
    200: {
      description: "Theme settings",
      content: {
        "application/json": {
          schema: successEnvelope(
            z
              .object({
                theme: themeDocumentSchema,
                revision: z.number().int().nonnegative(),
              })
              .passthrough(),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getThemeRoute, async (c) => {
  const db = c.get("db");
  const result = await getThemeSettings(db);
  return ok(c, result);
});

const saveThemeSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  theme: themeDocumentSchema,
});

const saveThemeRoute = createRoute({
  method: "post",
  path: "/theme",
  tags: ["Admin - Settings"],
  summary: "Save theme settings",
  request: {
    body: { content: { "application/json": { schema: saveThemeSchema } } },
  },
  responses: {
    200: {
      description: "Theme saved",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            theme: themeDocumentSchema,
            revision: z.number().int().positive(),
            message: z.string(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(saveThemeRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  const saved = await saveThemeSettings(
    db,
    body.theme,
    body.expectedRevision,
    user?.id ?? null,
  );
  await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
  return ok(c, {
    ...saved,
    message: "Theme settings saved successfully",
  });
});

const themeDraftSchema = z.object({
  theme: themeDocumentSchema,
  revision: z.number().int().nonnegative(),
  basePublishedRevision: z.number().int().nonnegative(),
  updatedAt: z.any().nullable(),
});

const themeWorkspaceSchema = z.object({
  published: z.object({
    theme: themeDocumentSchema,
    revision: z.number().int().nonnegative(),
  }),
  draft: themeDraftSchema,
});

const getThemeWorkspaceRoute = createRoute({
  method: "get",
  path: "/theme/workspace",
  tags: ["Admin - Settings"],
  summary: "Get published storefront style and durable draft",
  responses: {
    200: {
      description: "Theme workspace",
      content: { "application/json": { schema: successEnvelope(themeWorkspaceSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(getThemeWorkspaceRoute, async (c) => {
  return ok(c, await getThemeWorkspace(c.get("db")));
});

const saveThemeDraftSchema = z.object({
  theme: themeDocumentSchema,
  expectedDraftRevision: z.number().int().nonnegative(),
  basePublishedRevision: z.number().int().nonnegative(),
});

const saveThemeDraftRoute = createRoute({
  method: "post",
  path: "/theme/draft",
  tags: ["Admin - Settings"],
  summary: "Save the durable storefront style draft",
  request: { body: { content: { "application/json": { schema: saveThemeDraftSchema } } } },
  responses: {
    200: {
      description: "Draft saved",
      content: { "application/json": { schema: successEnvelope(themeDraftSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(saveThemeDraftRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(c, await saveThemeDraft(
    c.get("db"),
    body.theme,
    body.expectedDraftRevision,
    body.basePublishedRevision,
    user?.id ?? null,
  ));
});

const rebaseThemeDraftRoute = createRoute({
  method: "post",
  path: "/theme/draft/rebase",
  tags: ["Admin - Settings"],
  summary: "Rebase a storefront style draft onto the current published revision",
  request: { body: { content: { "application/json": { schema: saveThemeDraftSchema } } } },
  responses: {
    200: {
      description: "Draft rebased",
      content: { "application/json": { schema: successEnvelope(themeDraftSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(rebaseThemeDraftRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(c, await rebaseThemeDraft(
    c.get("db"),
    body.theme,
    body.expectedDraftRevision,
    body.basePublishedRevision,
    user?.id ?? null,
  ));
});

const publishThemeDraftSchema = z.object({
  expectedPublishedRevision: z.number().int().nonnegative(),
  expectedDraftRevision: z.number().int().positive(),
});

const publishThemeDraftRoute = createRoute({
  method: "post",
  path: "/theme/publish",
  tags: ["Admin - Settings"],
  summary: "Publish the exact durable storefront style draft",
  request: { body: { content: { "application/json": { schema: publishThemeDraftSchema } } } },
  responses: {
    200: {
      description: "Draft published",
      content: { "application/json": { schema: successEnvelope(themeWorkspaceSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(publishThemeDraftRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  const workspace = await publishThemeDraft(
    c.get("db"),
    body.expectedPublishedRevision,
    body.expectedDraftRevision,
    user?.id ?? null,
  );
  await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
  return ok(c, workspace);
});

const themeVersionSchema = z.object({
  id: z.string(),
  theme: themeDocumentSchema,
  revision: z.number().int().positive(),
  source: z.enum(["publish", "rollback", "migration"]),
  sourceRevision: z.number().int().positive().nullable(),
  publishedBy: z.string().nullable(),
  createdAt: z.any(),
});

const listThemeVersionsRoute = createRoute({
  method: "get",
  path: "/theme/versions",
  tags: ["Admin - Settings"],
  summary: "List immutable published storefront style revisions",
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) },
  responses: {
    200: {
      description: "Published theme revisions",
      content: { "application/json": { schema: successEnvelope(z.object({ versions: z.array(themeVersionSchema) })) } },
    },
    ...errorResponses,
  },
});

app.openapi(listThemeVersionsRoute, async (c) => {
  return ok(c, { versions: await listThemeVersions(c.get("db"), c.req.valid("query").limit) });
});

const rollbackThemeRoute = createRoute({
  method: "post",
  path: "/theme/rollback",
  tags: ["Admin - Settings"],
  summary: "Restore a published storefront style as a new revision",
  request: { body: { content: { "application/json": { schema: z.object({
    sourceRevision: z.number().int().positive(),
    expectedPublishedRevision: z.number().int().nonnegative(),
    expectedDraftRevision: z.number().int().positive(),
  }) } } } },
  responses: {
    200: {
      description: "Theme rollback published",
      content: { "application/json": { schema: successEnvelope(themeWorkspaceSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(rollbackThemeRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  const workspace = await rollbackThemeSettings(
    c.get("db"),
    body.sourceRevision,
    body.expectedPublishedRevision,
    body.expectedDraftRevision,
    user?.id ?? null,
  );
  await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
  return ok(c, workspace);
});

const createThemePreviewRoute = createRoute({
  method: "post",
  path: "/theme/preview-session",
  tags: ["Admin - Settings"],
  summary: "Create a short-lived exact-draft storefront preview session",
  request: { body: { content: { "application/json": { schema: z.object({
    expectedDraftRevision: z.number().int().positive(),
  }) } } } },
  responses: {
    200: {
      description: "Preview handoff",
      content: { "application/json": { schema: successEnvelope(z.object({
        token: z.string(),
        draftRevision: z.number().int().positive(),
        basePublishedRevision: z.number().int().nonnegative(),
        expiresAt: z.any(),
      })) } },
    },
    ...errorResponses,
  },
});

app.openapi(createThemePreviewRoute, async (c) => {
  const user = c.get("user") as { id?: string } | undefined;
  const preview = await createThemePreviewSession(
    c.get("db"),
    c.req.valid("json").expectedDraftRevision,
    user?.id ?? null,
  );
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  return ok(c, {
    token: preview.token,
    draftRevision: preview.draftRevision,
    basePublishedRevision: preview.basePublishedRevision,
    expiresAt: preview.expiresAt,
  });
});

// ─────────────────────────────────────────
// MEDIA / IMAGE OPTIMIZATION
// ─────────────────────────────────────────

const mediaOptimizationSchema = z.object({
  enabled: z.boolean().default(true),
  canonicalCdnUrl: z.string().default("").refine(isValidMediaHostInput, {
    message:
      "Use a hostname only, without paths, queries, wildcards, or credentials.",
  }),
  allowedImageHosts: z
    .array(
      z.string().refine(isValidMediaHostInput, {
        message:
          "Use hostnames only, without paths, queries, wildcards, or credentials.",
      }),
    )
    .default([]),
  canonicalHostAliases: z
    .array(
      z.string().refine(isValidMediaHostInput, {
        message:
          "Use hostnames only, without paths, queries, wildcards, or credentials.",
      }),
    )
    .default([]),
});
const mediaOptimizationSaveResponseSchema = mediaOptimizationSchema.extend({
  message: z.string(),
});

const getMediaOptimizationRoute = createRoute({
  method: "get",
  path: "/media",
  tags: ["Admin - Settings"],
  summary: "Get media and image optimization settings",
  responses: {
    200: {
      description: "Media settings",
      content: {
        "application/json": {
          schema: successEnvelope(mediaOptimizationSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getMediaOptimizationRoute, async (c) => {
  const db = c.get("db");
  const result = await getMediaOptimizationSettings(db);
  return ok(c, result);
});

const saveMediaOptimizationRoute = createRoute({
  method: "post",
  path: "/media",
  tags: ["Admin - Settings"],
  summary: "Save media and image optimization settings",
  request: {
    body: {
      content: {
        "application/json": { schema: mediaOptimizationSchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Media settings saved",
      content: {
        "application/json": {
          schema: successEnvelope(mediaOptimizationSaveResponseSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(saveMediaOptimizationRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const saved = await saveMediaOptimizationSettings(db, body);
  await invalidateApiAndScheduleStorefrontGroups(MEDIA_CACHE_GROUPS, c);
  return ok(c, { message: "Media settings saved successfully", ...saved });
});

// ─────────────────────────────────────────
// SEO
// ─────────────────────────────────────────

const seoSettingsSchema = z.object({
  siteTitle: z.string(),
  homepageTitle: z.string(),
  homepageMetaDescription: z.string(),
  robotsTxt: z.string(),
  discovery: z.object({
    sitemap: z.object({
      enabled: z.boolean(),
      staticPages: z.boolean(),
      products: z.boolean(),
      categories: z.boolean(),
      collections: z.boolean(),
      pages: z.boolean(),
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
    }),
  }),
  returnPolicy: z.object({
    enabled: z.boolean(),
    country: z.string(),
    category: z.enum(SEO_RETURN_POLICY_CATEGORIES),
    returnWindowDays: z.number().int().min(1).max(365).nullable(),
    returnFees: z.enum(SEO_RETURN_POLICY_FEES),
    returnMethod: z.enum(SEO_RETURN_POLICY_METHODS),
    policyUrl: z.string(),
  }),
});

const getSeoRoute = createRoute({
  method: "get",
  path: "/seo",
  tags: ["Admin - Settings"],
  summary: "Get SEO settings",
  responses: {
    200: {
      description: "SEO settings",
      content: {
        "application/json": { schema: successEnvelope(seoSettingsSchema) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getSeoRoute, async (c) => {
  const db = c.get("db");
  const result = await getSeoSettings(db);
  return ok(c, result);
});

const productFeedDiagnosticReasonSchema = z.enum(PRODUCT_FEED_DIAGNOSTIC_REASONS);

const productFeedDiagnosticSampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  reason: productFeedDiagnosticReasonSchema,
});

const productFeedDiagnosticReasonSummarySchema = z.object({
  reason: productFeedDiagnosticReasonSchema,
  products: z.number(),
  rows: z.number(),
  samples: z.array(productFeedDiagnosticSampleSchema),
});

const productFeedDiagnosticsSchema = z.object({
  policy: z.object({
    productCatalogEnabled: z.boolean(),
    includeUnavailableProducts: z.boolean(),
    variantStrategy: z.enum(["products", "variants"]),
  }),
  scan: z.object({
    limit: z.number(),
    scannedProducts: z.number(),
    truncated: z.boolean(),
    sampleLimitPerReason: z.number(),
  }),
  totals: z.object({
    emittedRows: z.number(),
    emittedProductRows: z.number(),
    emittedVariantRows: z.number(),
    productsWithIssues: z.number(),
    skippedRows: z.number(),
  }),
  reasons: z.array(productFeedDiagnosticReasonSummarySchema),
});

const productFeedDiagnosticsQuerySchema = z.object({
  scanLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PRODUCT_FEED_DIAGNOSTIC_MAX_SCAN_LIMIT)
    .optional(),
  sampleLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT)
    .optional(),
});

const getSeoFeedDiagnosticsRoute = createRoute({
  method: "get",
  path: "/seo/feed-diagnostics",
  tags: ["Admin - Settings"],
  summary: "Get product feed diagnostics",
  request: {
    query: productFeedDiagnosticsQuerySchema,
  },
  responses: {
    200: {
      description: "Product feed diagnostics",
      content: {
        "application/json": {
          schema: successEnvelope(productFeedDiagnosticsSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getSeoFeedDiagnosticsRoute, async (c) => {
  const db = c.get("db");
  const query = c.req.valid("query");
  const [seo, currency] = await Promise.all([
    getSeoSettings(db),
    getCurrencySettings(db),
  ]);
  const diagnostics = await getProductFeedDiagnostics(db, seo.discovery.feeds, {
    scanLimit: query.scanLimit,
    sampleLimitPerReason: query.sampleLimit,
    storefrontBaseUrl: c.env.STOREFRONT_URL,
    currencyCode: currency.currencyCode,
  });
  return ok(c, diagnostics);
});

const saveSeoDiscoverySchema = z.object({
  sitemap: seoSettingsSchema.shape.discovery.shape.sitemap.partial().optional(),
  feeds: seoSettingsSchema.shape.discovery.shape.feeds.partial().optional(),
  robots: seoSettingsSchema.shape.discovery.shape.robots.partial().optional(),
  structuredData: seoSettingsSchema.shape.discovery.shape.structuredData.partial().optional(),
});

const saveSeoReturnPolicySchema = z.object({
  enabled: z.boolean().optional(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter ISO country code")
    .optional(),
  category: z.enum(SEO_RETURN_POLICY_CATEGORIES).optional(),
  returnWindowDays: z.number().int().min(1).max(365).nullable().optional(),
  returnFees: z.enum(SEO_RETURN_POLICY_FEES).optional(),
  returnMethod: z.enum(SEO_RETURN_POLICY_METHODS).optional(),
  policyUrl: z
    .string()
    .max(2048)
    .refine(
      (value) => isValidSeoReturnPolicyUrl(value),
      "Policy URL must be blank, a same-origin path, or an absolute http(s) URL",
    )
    .optional(),
});

const saveSeoSchema = z.object({
  siteTitle: z.string().optional(),
  homepageTitle: z.string().optional(),
  homepageMetaDescription: z.string().optional(),
  robotsTxt: z.string().optional(),
  discovery: saveSeoDiscoverySchema.optional(),
  returnPolicy: saveSeoReturnPolicySchema.optional(),
});

const saveSeoRoute = createRoute({
  method: "post",
  path: "/seo",
  tags: ["Admin - Settings"],
  summary: "Save SEO settings",
  request: {
    body: { content: { "application/json": { schema: saveSeoSchema } } },
  },
  responses: {
    200: {
      description: "SEO saved",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(saveSeoRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  await saveSeoSettings(db, data);
  await invalidateSiteSettingsCache(getKv());
  await invalidateApiAndScheduleStorefrontGroups(
    [
      ...HOMEPAGE_CACHE_GROUPS,
      ...LAYOUT_CACHE_GROUPS,
      ...DISCOVERY_CACHE_GROUPS,
    ] as const,
    c,
    { htmlPaths: SEO_DISCOVERY_WARM_PATHS },
  );
  return ok(c, { message: "SEO settings saved successfully" });
});

// ─────────────────────────────────────────
// STOREFRONT URL
// ─────────────────────────────────────────

const getStorefrontUrlRoute = createRoute({
  method: "get",
  path: "/storefront-url",
  tags: ["Admin - Settings"],
  summary: "Get storefront URL",
  responses: {
    200: {
      description: "Storefront URL",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ storefrontUrl: z.string() })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getStorefrontUrlRoute, async (c) => {
  try {
    const db = c.get("db");
    const result = await getStorefrontUrlSetting(db);
    return ok(c, result);
  } catch {
    return ok(c, { storefrontUrl: "/" });
  }
});

const saveStorefrontUrlSchema = z.object({
  storefrontUrl: z.string().optional(),
});

const saveStorefrontUrlRoute = createRoute({
  method: "post",
  path: "/storefront-url",
  tags: ["Admin - Settings"],
  summary: "Save storefront URL",
  request: {
    body: {
      content: { "application/json": { schema: saveStorefrontUrlSchema } },
    },
  },
  responses: {
    200: {
      description: "URL saved",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(saveStorefrontUrlRoute, async (c) => {
  const db = c.get("db");
  const { storefrontUrl } = c.req.valid("json");
  await saveStorefrontUrl(db, storefrontUrl);
  layoutCache.invalidate(CACHE_KEYS.STOREFRONT_URL);
  const kv = getKv();
  await Promise.all([
    invalidateSiteSettingsCache(kv),
    invalidateStorefrontUrlCache(kv),
  ]);
  await invalidateApiAndScheduleStorefrontGroups(STOREFRONT_URL_CACHE_GROUPS, c, {
    htmlPaths: SEO_DISCOVERY_WARM_PATHS,
  });
  return ok(c, { message: "Storefront URL saved successfully" });
});

// ─────────────────────────────────────────
// HOMEPAGE PRESENTATION
// ─────────────────────────────────────────

const homepagePresentationConfigSchema = z.object({
  categoryRail: z.object({
    enabled: z.boolean(),
    title: z.string().max(MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH),
    categoryIds: z.array(z.string().min(1)).max(MAX_HOMEPAGE_CATEGORY_IDS),
  }),
  trustStrip: z.object({
    enabled: z.boolean(),
  }),
});

const homepagePresentationDocumentSchema = z.object({
  config: homepagePresentationConfigSchema,
  revision: z.number().int().nonnegative(),
});

const getHomepagePresentationRoute = createRoute({
  method: "get",
  path: "/homepage-presentation",
  tags: ["Admin - Settings"],
  summary: "Get the ordered homepage category and trust presentation",
  responses: {
    200: {
      description: "Homepage presentation",
      content: {
        "application/json": {
          schema: successEnvelope(homepagePresentationDocumentSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getHomepagePresentationRoute, async (c) => {
  return ok(c, await getHomepagePresentationSettings(c.get("db")));
});

const saveHomepagePresentationRoute = createRoute({
  method: "post",
  path: "/homepage-presentation",
  tags: ["Admin - Settings"],
  summary: "Save the ordered homepage category and trust presentation",
  request: {
    body: {
      content: {
        "application/json": {
          schema: homepagePresentationConfigSchema.extend({
            expectedRevision: z.number().int().nonnegative(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Homepage presentation saved",
      content: {
        "application/json": {
          schema: successEnvelope(homepagePresentationDocumentSchema),
        },
      },
    },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(saveHomepagePresentationRoute, async (c) => {
  const { expectedRevision, ...config } = c.req.valid("json");
  const saved = await saveHomepagePresentationSettings(
    c.get("db"),
    config,
    expectedRevision,
  );
  await invalidateSiteSettingsCache(getKv());
  await invalidateApiAndScheduleStorefrontGroups(HOMEPAGE_CACHE_GROUPS, c);
  return ok(c, saved);
});

// ── Allowed Countries ──

const getAllowedCountriesRoute = createRoute({
  method: "get",
  path: "/allowed-countries",
  tags: ["Admin - Settings"],
  summary: "Get allowed countries for phone numbers",
  responses: {
    200: {
      description: "Allowed countries list",
      content: {
        "application/json": {
          schema: successEnvelope(
            z
              .object({
                allowedCountries: z.array(z.string()),
                allowedCountriesMode: z.string(),
              })
              .passthrough(),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getAllowedCountriesRoute, async (c) => {
  const db = c.get("db");
  const result = await getAllowedCountries(db);
  return ok(c, result);
});

const saveAllowedCountriesRoute = createRoute({
  method: "put",
  path: "/allowed-countries",
  tags: ["Admin - Settings"],
  summary: "Save allowed countries for phone numbers",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            allowedCountries: z.array(z.string()),
            mode: z.enum(["include", "exclude"]).optional().default("include"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Countries saved",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(saveAllowedCountriesRoute, async (c) => {
  const db = c.get("db");
  const { allowedCountries, mode } = c.req.valid("json");
  const result = await saveAllowedCountries(
    db,
    allowedCountries,
    mode || "include",
  );
  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return ok(c, { message: "Allowed countries saved", ...result });
});

export { app as siteSettingsRoutes };
