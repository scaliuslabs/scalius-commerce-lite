import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  invalidateSiteSettingsCache,
  invalidateStorefrontUrlCache,
} from "@scalius/core/modules/settings";
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
import { SUPPORTED_CURRENCY_CODES } from "@scalius/shared/currency";
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
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import {
  runSeoDiscoveryLiveProbe,
  type SeoDiscoveryLiveProbeResult,
} from "@scalius/shared/seo-discovery-live-probe";
import { ServiceUnavailableError } from "@scalius/core/errors";
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
  serviceUnavailableResponse,
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
async function deleteLegacyCurrencyGatewayCache(
  kv?: KVNamespace | null,
): Promise<void> {
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

const CURRENCY_SYMBOL_MAX_LENGTH = 16;
const CURRENCY_EXCHANGE_RATE_MAX_LENGTH = 64;

const supportedCurrencyCodeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(SUPPORTED_CURRENCY_CODES, {
    error: "Select a supported three-letter currency code.",
  }),
);

const currencySettingsSchema = z.object({
  currencyCode: z.enum(SUPPORTED_CURRENCY_CODES),
  currencySymbol: z.string().max(CURRENCY_SYMBOL_MAX_LENGTH),
  usdExchangeRate: z.string().max(CURRENCY_EXCHANGE_RATE_MAX_LENGTH),
  currencyCodeLocked: z.boolean(),
});

const getCurrencyRoute = createRoute({
  method: "get",
  path: "/currency",
  tags: ["Admin - Settings"],
  summary: "Get currency settings",
  operationId: "dashboard.settings.currency_get",
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
  return ok(c, {
    ...result,
    currencySymbol: result.currencySymbol.slice(0, CURRENCY_SYMBOL_MAX_LENGTH),
    usdExchangeRate: result.usdExchangeRate.slice(
      0,
      CURRENCY_EXCHANGE_RATE_MAX_LENGTH,
    ),
    currencyCodeLocked,
  });
});

const saveCurrencySchema = z.object({
  currencyCode: supportedCurrencyCodeSchema.optional(),
  currencySymbol: z.string().max(CURRENCY_SYMBOL_MAX_LENGTH).optional(),
  usdExchangeRate: z
    .string()
    .trim()
    .max(CURRENCY_EXCHANGE_RATE_MAX_LENGTH)
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
  operationId: "dashboard.settings.currency_update",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: saveCurrencySchema } },
    },
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

  const kv = c.env.CACHE;
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
  operationId: "dashboard.settings.general_get",
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
const SITE_PRESENTATION_TEXT_MAX_LENGTH = 2_000;
const SITE_PRESENTATION_URL_MAX_LENGTH = 2_048;
const SITE_PRESENTATION_SOCIAL_MAX_COUNT = 24;

function presentationRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function presentationText(
  value: unknown,
  maximumLength: number,
  fallback = "",
): string {
  return typeof value === "string" ? value.slice(0, maximumLength) : fallback;
}

const socialLinkSchema = z.object({
  id: z.string().max(128),
  label: z.string().max(200),
  url: z.string().max(SITE_PRESENTATION_URL_MAX_LENGTH),
  iconUrl: z.string().max(SITE_PRESENTATION_URL_MAX_LENGTH).optional(),
});
const headerLogoWidthSchema = z
  .number()
  .int()
  .min(HEADER_LOGO_WIDTH_MIN)
  .max(HEADER_LOGO_WIDTH_MAX)
  .multipleOf(HEADER_LOGO_WIDTH_STEP);
const headerConfigSchema = z.object({
  topBar: z.object({
    text: z.string().max(SITE_PRESENTATION_TEXT_MAX_LENGTH),
    isEnabled: z.boolean().optional().default(true),
  }),
  logo: z.object({
    src: z.string().max(SITE_PRESENTATION_URL_MAX_LENGTH),
    alt: z.string().max(200),
    width: headerLogoWidthSchema.optional().default(HEADER_LOGO_WIDTH_DEFAULT),
  }),
  favicon: z.object({
    src: z.string().max(SITE_PRESENTATION_URL_MAX_LENGTH),
    alt: z.string().max(200),
  }),
  contact: z.object({
    phone: z.string().max(64),
    text: z.string().max(200),
    isEnabled: z.boolean().optional().default(true),
  }),
  social: z.array(socialLinkSchema).max(SITE_PRESENTATION_SOCIAL_MAX_COUNT),
});

function projectSocialLinks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SITE_PRESENTATION_SOCIAL_MAX_COUNT).map((entry) => {
    const link = presentationRecord(entry);
    const iconUrl = presentationText(
      link.iconUrl,
      SITE_PRESENTATION_URL_MAX_LENGTH,
    );
    return {
      id: presentationText(link.id, 128),
      label: presentationText(link.label, 200),
      url: presentationText(link.url, SITE_PRESENTATION_URL_MAX_LENGTH),
      ...(iconUrl ? { iconUrl } : {}),
    };
  });
}

function projectHeaderConfig(value: unknown): z.infer<typeof headerConfigSchema> {
  const root = presentationRecord(value);
  const topBar = presentationRecord(root.topBar);
  const logo = presentationRecord(root.logo);
  const favicon = presentationRecord(root.favicon);
  const contact = presentationRecord(root.contact);
  const width = headerLogoWidthSchema.safeParse(logo.width);
  return {
    topBar: {
      text: presentationText(topBar.text, SITE_PRESENTATION_TEXT_MAX_LENGTH),
      isEnabled: topBar.isEnabled === true,
    },
    logo: {
      src: presentationText(logo.src, SITE_PRESENTATION_URL_MAX_LENGTH),
      alt: presentationText(logo.alt, 200),
      width: width.success ? width.data : HEADER_LOGO_WIDTH_DEFAULT,
    },
    favicon: {
      src: presentationText(favicon.src, SITE_PRESENTATION_URL_MAX_LENGTH),
      alt: presentationText(favicon.alt, 200),
    },
    contact: {
      phone: presentationText(contact.phone, 64),
      text: presentationText(contact.text, 200),
      isEnabled: contact.isEnabled === true,
    },
    social: projectSocialLinks(root.social),
  };
}

const headerDocumentSchema = z.object({
  config: headerConfigSchema,
  revision: z.number().int().nonnegative(),
});

const getHeaderRoute = createRoute({
  method: "get",
  path: "/header",
  operationId: "dashboard.settings_header.get_header",
  tags: ["Admin - Settings"],
  summary: "Get bounded header configuration and revision",
  responses: {
    200: {
      description: "Header configuration",
      content: {
        "application/json": { schema: successEnvelope(headerDocumentSchema) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getHeaderRoute, async (c) => {
  const settings = await getGeneralSettings(c.get("db"));
  const config = projectHeaderConfig(settings.headerConfig);
  return ok(c, { config, revision: settings.revisions.header });
});

const saveHeaderSchema = headerConfigSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});

const saveHeaderRoute = createRoute({
  method: "post",
  path: "/header",
  operationId: "dashboard.settings_header.header",
  tags: ["Admin - Settings"],
  summary: "Save header configuration",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: saveHeaderSchema } },
    },
  },
  responses: {
    200: {
      description: "Header saved",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              revision: z.number().int().positive(),
            }),
          ),
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
  await invalidateSiteSettingsCache(c.env.CACHE);
  await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
  return ok(c, saved);
});

// ─────────────────────────────────────────
// FOOTER
// ─────────────────────────────────────────
const footerConfigSchema = z.object({
  logo: z.object({
    src: z.string().max(SITE_PRESENTATION_URL_MAX_LENGTH),
    alt: z.string().max(200),
  }),
  tagline: z.string().max(SITE_PRESENTATION_TEXT_MAX_LENGTH).optional().default(""),
  description: z.string().max(SITE_PRESENTATION_TEXT_MAX_LENGTH).optional().default(""),
  copyrightText: z.string().max(SITE_PRESENTATION_TEXT_MAX_LENGTH).optional().default(""),
  social: z.array(socialLinkSchema).max(SITE_PRESENTATION_SOCIAL_MAX_COUNT),
});

function projectFooterConfig(value: unknown): z.infer<typeof footerConfigSchema> {
  const root = presentationRecord(value);
  const logo = presentationRecord(root.logo);
  return {
    logo: {
      src: presentationText(logo.src, SITE_PRESENTATION_URL_MAX_LENGTH),
      alt: presentationText(logo.alt, 200),
    },
    tagline: presentationText(root.tagline, SITE_PRESENTATION_TEXT_MAX_LENGTH),
    description: presentationText(
      root.description,
      SITE_PRESENTATION_TEXT_MAX_LENGTH,
    ),
    copyrightText: presentationText(
      root.copyrightText,
      SITE_PRESENTATION_TEXT_MAX_LENGTH,
      "Your store",
    ),
    social: projectSocialLinks(root.social),
  };
}

const footerDocumentSchema = z.object({
  config: footerConfigSchema,
  revision: z.number().int().nonnegative(),
});

const getFooterRoute = createRoute({
  method: "get",
  path: "/footer",
  operationId: "dashboard.settings_footer.get_footer",
  tags: ["Admin - Settings"],
  summary: "Get bounded footer configuration and revision",
  responses: {
    200: {
      description: "Footer configuration",
      content: {
        "application/json": { schema: successEnvelope(footerDocumentSchema) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getFooterRoute, async (c) => {
  const settings = await getGeneralSettings(c.get("db"));
  const config = projectFooterConfig(settings.footerConfig);
  return ok(c, { config, revision: settings.revisions.footer });
});

const saveFooterSchema = footerConfigSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});

const saveFooterRoute = createRoute({
  method: "post",
  path: "/footer",
  operationId: "dashboard.settings_footer.footer",
  tags: ["Admin - Settings"],
  summary: "Save footer configuration",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: saveFooterSchema } },
    },
  },
  responses: {
    200: {
      description: "Footer saved",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              revision: z.number().int().positive(),
            }),
          ),
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
  await invalidateSiteSettingsCache(c.env.CACHE);
  await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
  return ok(c, saved);
});

// ─────────────────────────────────────────
// THEME
// ─────────────────────────────────────────

const themeDocumentSchema = z
  .object({
    colors: z.record(z.string(), z.string()),
    typography: z
      .object({
        heading: z.enum(STOREFRONT_THEME_HEADING_FONTS),
        body: z.enum(STOREFRONT_THEME_BODY_FONTS),
        scale: z.enum(STOREFRONT_THEME_TYPE_SCALES),
      })
      .strict(),
    cornerStyle: z.enum(STOREFRONT_THEME_CORNER_STYLES),
    density: z.enum(STOREFRONT_THEME_DENSITIES),
    containerWidth: z.enum(STOREFRONT_THEME_CONTAINER_WIDTHS),
    components: z
      .object({
        buttons: z.enum(STOREFRONT_THEME_BUTTON_STYLES),
        inputs: z.enum(STOREFRONT_THEME_INPUT_STYLES),
        cards: z.enum(STOREFRONT_THEME_CARD_STYLES),
      })
      .strict(),
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
  operationId: "dashboard.theme.get",
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
  operationId: "dashboard.theme.save_legacy",
  request: {
    body: { content: { "application/json": { schema: saveThemeSchema } } },
  },
  responses: {
    200: {
      description: "Theme saved",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              theme: themeDocumentSchema,
              revision: z.number().int().positive(),
              message: z.string(),
            }),
          ),
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
  operationId: "dashboard.theme.workspace_get",
  responses: {
    200: {
      description: "Theme workspace",
      content: {
        "application/json": { schema: successEnvelope(themeWorkspaceSchema) },
      },
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
  operationId: "dashboard.theme.draft_save",
  request: {
    body: { content: { "application/json": { schema: saveThemeDraftSchema } } },
  },
  responses: {
    200: {
      description: "Draft saved",
      content: {
        "application/json": { schema: successEnvelope(themeDraftSchema) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(saveThemeDraftRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(
    c,
    await saveThemeDraft(
      c.get("db"),
      body.theme,
      body.expectedDraftRevision,
      body.basePublishedRevision,
      user?.id ?? null,
    ),
  );
});

const rebaseThemeDraftRoute = createRoute({
  method: "post",
  path: "/theme/draft/rebase",
  tags: ["Admin - Settings"],
  summary:
    "Rebase a storefront style draft onto the current published revision",
  operationId: "dashboard.theme.draft_rebase",
  request: {
    body: { content: { "application/json": { schema: saveThemeDraftSchema } } },
  },
  responses: {
    200: {
      description: "Draft rebased",
      content: {
        "application/json": { schema: successEnvelope(themeDraftSchema) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(rebaseThemeDraftRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(
    c,
    await rebaseThemeDraft(
      c.get("db"),
      body.theme,
      body.expectedDraftRevision,
      body.basePublishedRevision,
      user?.id ?? null,
    ),
  );
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
  operationId: "dashboard.theme.publish",
  request: {
    body: {
      content: { "application/json": { schema: publishThemeDraftSchema } },
    },
  },
  responses: {
    200: {
      description: "Draft published",
      content: {
        "application/json": { schema: successEnvelope(themeWorkspaceSchema) },
      },
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
  operationId: "dashboard.theme.versions_list",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  },
  responses: {
    200: {
      description: "Published theme revisions",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({ versions: z.array(themeVersionSchema) }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(listThemeVersionsRoute, async (c) => {
  return ok(c, {
    versions: await listThemeVersions(c.get("db"), c.req.valid("query").limit),
  });
});

const rollbackThemeRoute = createRoute({
  method: "post",
  path: "/theme/rollback",
  tags: ["Admin - Settings"],
  summary: "Restore a published storefront style as a new revision",
  operationId: "dashboard.theme.rollback",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            sourceRevision: z.number().int().positive(),
            expectedPublishedRevision: z.number().int().nonnegative(),
            expectedDraftRevision: z.number().int().positive(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Theme rollback published",
      content: {
        "application/json": { schema: successEnvelope(themeWorkspaceSchema) },
      },
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
  operationId: "dashboard.theme.preview_session_create",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            expectedDraftRevision: z.number().int().positive(),
            path: z.string().trim().min(1).max(512).default("/"),
            device: z.enum(["full", "desktop", "mobile"]).default("full"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Preview handoff",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              continuation: z.object({
                url: z.url().max(512),
                method: z.literal("POST"),
                fields: z.object({
                  continuationCode: z.string().length(52).regex(/^tpc_[A-Za-z0-9_-]{48}$/),
                  path: z.string().min(1).max(512),
                  device: z.enum(["full", "desktop", "mobile"]),
                }),
              }),
              draftRevision: z.number().int().positive(),
              basePublishedRevision: z.number().int().nonnegative(),
              expiresAt: z.any(),
            }),
          ),
        },
      },
    },
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

app.openapi(createThemePreviewRoute, async (c) => {
  const user = c.get("user") as { id?: string } | undefined;
  const body = c.req.valid("json");
  const storefrontOrigin = normalizeStorefrontOrigin(c.env.STOREFRONT_URL);
  if (!storefrontOrigin) {
    throw new ServiceUnavailableError(
      "Configure a valid HTTPS Storefront URL before opening a draft preview.",
    );
  }
  const preview = await createThemePreviewSession(
    c.get("db"),
    body.expectedDraftRevision,
    user?.id ?? null,
  );
  const continuationUrl = new URL("/theme-preview/continue", storefrontOrigin);
  if (continuationUrl.toString().length > 512) {
    throw new ServiceUnavailableError(
      "Configure a shorter Storefront URL before opening a draft preview.",
    );
  }
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Referrer-Policy", "no-referrer");
  return ok(c, {
    continuation: {
      url: continuationUrl.toString(),
      method: "POST" as const,
      fields: {
        continuationCode: preview.continuationId,
        path: body.path,
        device: body.device,
      },
    },
    draftRevision: preview.draftRevision,
    basePublishedRevision: preview.basePublishedRevision,
    expiresAt: preview.expiresAt,
  });
});

// ─────────────────────────────────────────
// MEDIA / IMAGE OPTIMIZATION
// ─────────────────────────────────────────

const MEDIA_HOST_MAX_LENGTH = 253;
const MEDIA_HOST_LIST_MAX_COUNT = 24;

const mediaOptimizationSchema = z.object({
  enabled: z.boolean().default(true),
  canonicalCdnUrl: z.string().max(MEDIA_HOST_MAX_LENGTH).default("").refine(isValidMediaHostInput, {
    message:
      "Use a hostname only, without paths, queries, wildcards, or credentials.",
  }),
  allowedImageHosts: z
    .array(
      z.string().max(MEDIA_HOST_MAX_LENGTH).refine(isValidMediaHostInput, {
        message:
          "Use hostnames only, without paths, queries, wildcards, or credentials.",
      }),
    ).max(MEDIA_HOST_LIST_MAX_COUNT)
    .default([]),
  canonicalHostAliases: z
    .array(
      z.string().max(MEDIA_HOST_MAX_LENGTH).refine(isValidMediaHostInput, {
        message:
          "Use hostnames only, without paths, queries, wildcards, or credentials.",
      }),
    ).max(MEDIA_HOST_LIST_MAX_COUNT)
    .default([]),
});

function projectMediaOptimizationSettings(
  settings: Awaited<ReturnType<typeof getMediaOptimizationSettings>>,
) {
  return {
    enabled: settings.enabled,
    canonicalCdnUrl: settings.canonicalCdnUrl.slice(0, MEDIA_HOST_MAX_LENGTH),
    allowedImageHosts: settings.allowedImageHosts.slice(
      0,
      MEDIA_HOST_LIST_MAX_COUNT,
    ).map((host) => host.slice(0, MEDIA_HOST_MAX_LENGTH)),
    canonicalHostAliases: settings.canonicalHostAliases.slice(
      0,
      MEDIA_HOST_LIST_MAX_COUNT,
    ).map((host) => host.slice(0, MEDIA_HOST_MAX_LENGTH)),
  };
}
const mediaOptimizationSaveResponseSchema = mediaOptimizationSchema.extend({
  message: z.string(),
});

const getMediaOptimizationRoute = createRoute({
  method: "get",
  path: "/media",
  tags: ["Admin - Settings"],
  summary: "Get media and image optimization settings",
  operationId: "dashboard.settings.media_delivery_get",
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
  return ok(c, projectMediaOptimizationSettings(result));
});

const saveMediaOptimizationRoute = createRoute({
  method: "post",
  path: "/media",
  tags: ["Admin - Settings"],
  summary: "Save media and image optimization settings",
  operationId: "dashboard.settings.media_delivery_update",
  request: {
    body: {
      required: true,
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
  return ok(c, {
    message: "Media settings saved successfully",
    ...projectMediaOptimizationSettings(saved),
  });
});

// ─────────────────────────────────────────
// SEO
// ─────────────────────────────────────────

const SEO_SITE_TITLE_MAX_LENGTH = 200;
const SEO_HOMEPAGE_TITLE_MAX_LENGTH = 200;
const SEO_META_DESCRIPTION_MAX_LENGTH = 1_000;
const SEO_ROBOTS_TXT_MAX_LENGTH = 32_768;
const SEO_FEED_TITLE_MAX_LENGTH = 200;
const SEO_FEED_DESCRIPTION_MAX_LENGTH = 2_000;
const SEO_POLICY_URL_MAX_LENGTH = 2_048;

function projectSeoSettings(
  settings: Awaited<ReturnType<typeof getSeoSettings>>,
): Awaited<ReturnType<typeof getSeoSettings>> {
  return {
    ...settings,
    siteTitle: settings.siteTitle.slice(0, SEO_SITE_TITLE_MAX_LENGTH),
    homepageTitle: settings.homepageTitle.slice(0, SEO_HOMEPAGE_TITLE_MAX_LENGTH),
    homepageMetaDescription: settings.homepageMetaDescription.slice(
      0,
      SEO_META_DESCRIPTION_MAX_LENGTH,
    ),
    robotsTxt: settings.robotsTxt.slice(0, SEO_ROBOTS_TXT_MAX_LENGTH),
    discovery: {
      ...settings.discovery,
      feeds: {
        ...settings.discovery.feeds,
        title: settings.discovery.feeds.title.slice(0, SEO_FEED_TITLE_MAX_LENGTH),
        description: settings.discovery.feeds.description.slice(
          0,
          SEO_FEED_DESCRIPTION_MAX_LENGTH,
        ),
      },
    },
    returnPolicy: {
      ...settings.returnPolicy,
      policyUrl: settings.returnPolicy.policyUrl.slice(
        0,
        SEO_POLICY_URL_MAX_LENGTH,
      ),
    },
  };
}

const seoSettingsSchema = z.object({
  siteTitle: z.string().max(SEO_SITE_TITLE_MAX_LENGTH),
  homepageTitle: z.string().max(SEO_HOMEPAGE_TITLE_MAX_LENGTH),
  homepageMetaDescription: z.string().max(SEO_META_DESCRIPTION_MAX_LENGTH),
  robotsTxt: z.string().max(SEO_ROBOTS_TXT_MAX_LENGTH),
  discovery: z.object({
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
      title: z.string().max(SEO_FEED_TITLE_MAX_LENGTH),
      description: z.string().max(SEO_FEED_DESCRIPTION_MAX_LENGTH),
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
  }),
  returnPolicy: z.object({
    enabled: z.boolean(),
    country: z.string(),
    category: z.enum(SEO_RETURN_POLICY_CATEGORIES),
    returnWindowDays: z.number().int().min(1).max(365).nullable(),
    returnFees: z.enum(SEO_RETURN_POLICY_FEES),
    returnMethod: z.enum(SEO_RETURN_POLICY_METHODS),
    policyUrl: z.string().max(SEO_POLICY_URL_MAX_LENGTH),
  }),
});

const getSeoRoute = createRoute({
  method: "get",
  path: "/seo",
  tags: ["Admin - Settings"],
  summary: "Get SEO settings",
  operationId: "dashboard.seo.settings_get",
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
  return ok(c, projectSeoSettings(result));
});

const productFeedDiagnosticReasonSchema = z.enum(
  PRODUCT_FEED_DIAGNOSTIC_REASONS,
);
const PRODUCT_FEED_DIAGNOSTIC_ID_MAX_LENGTH = 128;
const PRODUCT_FEED_DIAGNOSTIC_NAME_MAX_LENGTH = 200;
const PRODUCT_FEED_DIAGNOSTIC_SLUG_MAX_LENGTH = 200;

const productFeedDiagnosticSampleSchema = z.object({
  id: z.string().max(PRODUCT_FEED_DIAGNOSTIC_ID_MAX_LENGTH),
  name: z.string().max(PRODUCT_FEED_DIAGNOSTIC_NAME_MAX_LENGTH),
  slug: z.string().max(PRODUCT_FEED_DIAGNOSTIC_SLUG_MAX_LENGTH),
  reason: productFeedDiagnosticReasonSchema,
});

const productFeedDiagnosticReasonSummarySchema = z.object({
  reason: productFeedDiagnosticReasonSchema,
  products: z.number(),
  rows: z.number(),
  samples: z
    .array(productFeedDiagnosticSampleSchema)
    .max(PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT),
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
  reasons: z
    .array(productFeedDiagnosticReasonSummarySchema)
    .max(PRODUCT_FEED_DIAGNOSTIC_REASONS.length),
});

function projectProductFeedDiagnostics(
  diagnostics: Awaited<ReturnType<typeof getProductFeedDiagnostics>>,
) {
  return {
    ...diagnostics,
    reasons: diagnostics.reasons
      .slice(0, PRODUCT_FEED_DIAGNOSTIC_REASONS.length)
      .map((summary) => ({
        ...summary,
        samples: summary.samples
          .slice(0, PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT)
          .map((sample) => ({
            id: sample.id.slice(0, PRODUCT_FEED_DIAGNOSTIC_ID_MAX_LENGTH),
            name: sample.name.slice(0, PRODUCT_FEED_DIAGNOSTIC_NAME_MAX_LENGTH),
            slug: sample.slug.slice(0, PRODUCT_FEED_DIAGNOSTIC_SLUG_MAX_LENGTH),
            reason: sample.reason,
          })),
      })),
  };
}

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

const seoDiscoveryLiveProbeCountsSchema = z.object({
  robotsSitemapLines: z.number().optional(),
  sitemapLocs: z.number().optional(),
  feedItems: z.number().optional(),
  feedLinks: z.number().optional(),
  absoluteFeedLinks: z.number().optional(),
  imageLinks: z.number().optional(),
  absoluteImageLinks: z.number().optional(),
  availabilityValues: z.number().optional(),
  ucpValidJson: z.number().optional(),
  ucpVersion: z.string().optional(),
  ucpShoppingRestServices: z.number().optional(),
  ucpCatalogCapabilities: z.number().optional(),
  ucpForbiddenCapabilities: z.number().optional(),
  ucpPaymentHandlers: z.number().optional(),
});

const seoDiscoveryLiveProbeResourceSchema = z.object({
  key: z.enum([
    "robots",
    "sitemap",
    "productFeed",
    "facebookFeed",
    "ucpProfile",
    "staticPagesSitemap",
    "productsSitemap",
    "categoriesSitemap",
    "collectionsSitemap",
    "pagesSitemap",
    "articlesSitemap",
  ]),
  kind: z.enum(["robots", "sitemap", "feed", "ucpProfile", "sitemapChild"]),
  label: z.string(),
  path: z.string(),
  href: z.string().nullable(),
  ok: z.boolean(),
  status: z.number().int().nullable(),
  contentType: z.string().nullable(),
  cacheControl: z.string().nullable(),
  counts: seoDiscoveryLiveProbeCountsSchema,
  bodyTruncated: z.boolean().optional(),
  disabledReason: z.string().optional(),
  error: z.string().optional(),
  expectedRobotsSitemapLines: z.number().int().optional(),
  minimumSitemapLocs: z.number().int().optional(),
});

const seoDiscoveryLiveProbeResultSchema = z.object({
  baseUrl: z.string().nullable(),
  checkedAt: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  resources: z.array(seoDiscoveryLiveProbeResourceSchema),
});

const getSeoFeedDiagnosticsRoute = createRoute({
  method: "get",
  path: "/seo/feed-diagnostics",
  tags: ["Admin - Settings"],
  summary: "Get product feed diagnostics",
  operationId: "dashboard.seo.feed_diagnostics",
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
  return ok(c, projectProductFeedDiagnostics(diagnostics));
});

const getSeoLiveProbeRoute = createRoute({
  method: "get",
  path: "/seo/live-probe",
  tags: ["Admin - Settings"],
  summary: "Probe bounded public discovery resources",
  operationId: "dashboard.seo.live_probe",
  responses: {
    200: {
      description: "Bounded live discovery probe",
      content: {
        "application/json": {
          schema: successEnvelope(seoDiscoveryLiveProbeResultSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getSeoLiveProbeRoute, async (c) => {
  const db = c.get("db");
  const result: SeoDiscoveryLiveProbeResult = await runSeoDiscoveryLiveProbe({
    getDiscoveryPolicy: async () => getSeoSettings(db),
    getStorefrontUrl: async () => getStorefrontUrlSetting(db),
  });
  c.header("Cache-Control", "private, no-store");
  return ok(c, result);
});

const saveSeoDiscoverySchema = z.object({
  sitemap: seoSettingsSchema.shape.discovery.shape.sitemap.partial().optional(),
  feeds: seoSettingsSchema.shape.discovery.shape.feeds.partial().optional(),
  robots: seoSettingsSchema.shape.discovery.shape.robots.partial().optional(),
  structuredData: seoSettingsSchema.shape.discovery.shape.structuredData
    .partial()
    .optional(),
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
    .max(SEO_POLICY_URL_MAX_LENGTH)
    .refine(
      (value) => isValidSeoReturnPolicyUrl(value),
      "Policy URL must be blank, a same-origin path, or an absolute http(s) URL",
    )
    .optional(),
});

const saveSeoSchema = z.object({
  siteTitle: z.string().max(SEO_SITE_TITLE_MAX_LENGTH).optional(),
  homepageTitle: z.string().max(SEO_HOMEPAGE_TITLE_MAX_LENGTH).optional(),
  homepageMetaDescription: z
    .string()
    .max(SEO_META_DESCRIPTION_MAX_LENGTH)
    .optional(),
  robotsTxt: z.string().max(SEO_ROBOTS_TXT_MAX_LENGTH).optional(),
  discovery: saveSeoDiscoverySchema.optional(),
  returnPolicy: saveSeoReturnPolicySchema.optional(),
});

const saveSeoRoute = createRoute({
  method: "post",
  path: "/seo",
  tags: ["Admin - Settings"],
  summary: "Save SEO settings",
  operationId: "dashboard.seo.settings_update",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: saveSeoSchema } },
    },
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
  await invalidateSiteSettingsCache(c.env.CACHE);
  await invalidateApiAndScheduleStorefrontGroups(
    [
      ...HOMEPAGE_CACHE_GROUPS,
      ...LAYOUT_CACHE_GROUPS,
      ...DISCOVERY_CACHE_GROUPS,
    ] as const,
    c,
  );
  return ok(c, { message: "SEO settings saved successfully" });
});

// ─────────────────────────────────────────
// STOREFRONT URL
// ─────────────────────────────────────────

const STOREFRONT_URL_MAX_LENGTH = 2_048;

const getStorefrontUrlRoute = createRoute({
  method: "get",
  path: "/storefront-url",
  tags: ["Admin - Settings"],
  summary: "Get storefront URL",
  operationId: "dashboard.settings.storefront_url_get",
  responses: {
    200: {
      description: "Storefront URL",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              storefrontUrl: z.string().max(STOREFRONT_URL_MAX_LENGTH),
            }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getStorefrontUrlRoute, async (c) => {
  const db = c.get("db");
  const result = await getStorefrontUrlSetting(db);
  const storefrontUrl = normalizeStorefrontOrigin(result.storefrontUrl);
  return ok(c, {
    storefrontUrl:
      storefrontUrl && storefrontUrl.length <= STOREFRONT_URL_MAX_LENGTH
        ? storefrontUrl
        : "",
  });
});

const saveStorefrontUrlSchema = z.object({
  storefrontUrl: z
    .string()
    .trim()
    .min(1, "Enter the public store origin.")
    .max(STOREFRONT_URL_MAX_LENGTH)
    .refine(
      (value) => normalizeStorefrontOrigin(value) !== null,
      "Use an HTTPS origin without credentials, a path, query, or fragment. HTTP is limited to loopback development.",
    ),
});

const saveStorefrontUrlRoute = createRoute({
  method: "post",
  path: "/storefront-url",
  tags: ["Admin - Settings"],
  summary: "Save storefront URL",
  operationId: "dashboard.settings.storefront_url_update",
  request: {
    body: {
      required: true,
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
  const kv = c.env.CACHE;
  await Promise.all([
    invalidateSiteSettingsCache(kv),
    invalidateStorefrontUrlCache(kv),
  ]);
  await invalidateApiAndScheduleStorefrontGroups(
    STOREFRONT_URL_CACHE_GROUPS,
    c,
  );
  return ok(c, { message: "Storefront URL saved successfully" });
});

// ─────────────────────────────────────────
// HOMEPAGE PRESENTATION
// ─────────────────────────────────────────

const homepagePresentationConfigSchema = z.object({
  categoryRail: z.object({
    enabled: z.boolean(),
    title: z.string().max(MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH),
    categoryIds: z
      .array(z.string().min(1).max(128))
      .max(MAX_HOMEPAGE_CATEGORY_IDS),
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
  operationId: "dashboard.settings_homepage_presentation.get_homepage_presentation",
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
  operationId: "dashboard.settings_homepage_presentation.homepage_presentation",
  tags: ["Admin - Settings"],
  summary: "Save the ordered homepage category and trust presentation",
  request: {
    body: {
      required: true,
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
  await invalidateSiteSettingsCache(c.env.CACHE);
  await invalidateApiAndScheduleStorefrontGroups(HOMEPAGE_CACHE_GROUPS, c);
  return ok(c, saved);
});

// ── Allowed Countries ──

const COUNTRY_CODE_MAX_COUNT = 249;
const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

function projectAllowedCountries(settings: {
  allowedCountries: unknown[];
  allowedCountriesMode: unknown;
}): {
  allowedCountries: string[];
  allowedCountriesMode: "include" | "exclude";
} {
  return {
    allowedCountries: [
      ...new Set(
        settings.allowedCountries
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().toUpperCase())
          .filter((value) => /^[A-Z]{2}$/.test(value)),
      ),
    ].slice(0, COUNTRY_CODE_MAX_COUNT),
    allowedCountriesMode: settings.allowedCountriesMode === "exclude"
      ? ("exclude" as const)
      : ("include" as const),
  };
}

const getAllowedCountriesRoute = createRoute({
  method: "get",
  path: "/allowed-countries",
  tags: ["Admin - Settings"],
  summary: "Get allowed countries for phone numbers",
  operationId: "dashboard.settings.customer_countries_get",
  responses: {
    200: {
      description: "Allowed countries list",
      content: {
        "application/json": {
          schema: successEnvelope(
            z
              .object({
                allowedCountries: z
                  .array(countryCodeSchema)
                  .max(COUNTRY_CODE_MAX_COUNT),
                allowedCountriesMode: z.enum(["include", "exclude"]),
              })
              .strict(),
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
  return ok(c, projectAllowedCountries(result));
});

const saveAllowedCountriesRoute = createRoute({
  method: "put",
  path: "/allowed-countries",
  tags: ["Admin - Settings"],
  summary: "Save allowed countries for phone numbers",
  operationId: "dashboard.settings.customer_countries_update",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            allowedCountries: z
              .array(countryCodeSchema)
              .max(COUNTRY_CODE_MAX_COUNT),
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
  const projected = projectAllowedCountries({
    allowedCountries,
    allowedCountriesMode: mode,
  });
  const result = await saveAllowedCountries(
    db,
    projected.allowedCountries,
    projected.allowedCountriesMode,
  );
  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return ok(c, { message: "Allowed countries saved", ...result });
});

export { app as siteSettingsRoutes };
