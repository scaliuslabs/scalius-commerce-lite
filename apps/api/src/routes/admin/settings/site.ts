import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { storefrontLandingPageSchema, storefrontLandingSlugSchema, storefrontProductPageTemplateSchema, storefrontListingPageTemplateSchema, storefrontSectionListSchema } from "@scalius/shared/storefront-theme";
import { SUPPORTED_CURRENCY_CODES } from "@scalius/shared/currency";
import {
  SEO_RETURN_POLICY_CATEGORIES,
  SEO_RETURN_POLICY_FEES,
  SEO_RETURN_POLICY_METHODS,
  isValidSeoReturnPolicyUrl,
} from "@scalius/shared/seo-return-policy";
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
  getThemeWorkspace,
  saveThemeDraft,
  publishThemeDraft,
  listThemeVersions,
  rollbackThemeSettings,
  restoreThemeVersion,
  discardThemeDraft,
  saveThemePageDraft,
  createThemePreviewSession,
  THEME_VERSION_HISTORY_LIMIT,
  isValidMediaHostInput,
  saveMediaOptimizationSettings,
  getSeoSettings,
  saveSeoSettings,
  saveAllowedCountries,
  readSettingsForEdit,
  currencyDocument,
  customerCountriesDocument,
  mediaDocument,
  platformDocument,
  seoDocument,
} from "@scalius/core/modules/settings";
import { getStorefrontUrlSetting, saveStorefrontUrl } from "@scalius/core/modules/platform";
import {
  PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT,
  PRODUCT_FEED_DIAGNOSTIC_MAX_SCAN_LIMIT,
  PRODUCT_FEED_DIAGNOSTIC_REASONS,
  getProductFeedDiagnostics,
} from "@scalius/core/modules/catalog";

import { ok } from "../../../utils/api-response";
import {
  successEnvelope,
  errorResponses,
  conflictResponse,
  serviceUnavailableResponse,
} from "../../../schemas/responses";
import { storeShapeApiSchema, storefrontThemeDocumentApiSchema } from "../../../schemas/storefront-theme";
import { appSettingField, appSettingFieldSchema } from "../../../schemas/app-settings";
import { readStoreShape, readThemeMedia } from "@scalius/core/modules/storefront";
import { listPluginInstallations } from "@scalius/core/modules/plugins";
import { pluginSurfaceKey } from "@scalius/shared/plugins";
import { isPublicMediaUrl } from "@scalius/shared/platform-config";
const app = new OpenAPIHono<{ Bindings: Env }>();
const revisionSchema = z.number().int().nonnegative();
/** A save answers with the document revision the next save must send back. */
const savedRevisionResponse = successEnvelope(z.object({ message: z.string(), revision: revisionSchema }));
// ─────────────────────────────────────────
// CURRENCY
// ─────────────────────────────────────────

const CURRENCY_SYMBOL_MAX_LENGTH = 16;

const supportedCurrencyCodeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(SUPPORTED_CURRENCY_CODES, {
    error: "Select a supported three-letter currency code.",
  }),
);

const currencySettingsSchema = z.object({
  currencyCode: z.enum(SUPPORTED_CURRENCY_CODES),
  currencySymbol: z.string().max(CURRENCY_SYMBOL_MAX_LENGTH),
  currencyCodeLocked: z.boolean(),
  revision: revisionSchema,
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
  const { value: result, revision } = await readSettingsForEdit(db, currencyDocument);
  const currencyCodeLocked = await isCurrencyCodeLocked(db);
  return ok(c, {
    ...result,
    revision,
    currencySymbol: result.currencySymbol.slice(0, CURRENCY_SYMBOL_MAX_LENGTH),
    currencyCodeLocked,
  });
});

const saveCurrencySchema = z.object({
  expectedRevision: revisionSchema,
  currencyCode: supportedCurrencyCodeSchema.optional(),
  currencySymbol: z.string().max(CURRENCY_SYMBOL_MAX_LENGTH).optional(),
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
      content: { "application/json": { schema: savedRevisionResponse } },
    },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(saveCurrencyRoute, async (c) => {
  const { expectedRevision, ...body } = c.req.valid("json");
  const { revision } = await saveCurrencySettings(c.get("db"), body, { expectedRevision });

  return ok(c, { message: "Currency settings saved successfully", revision });
});

// ─────────────────────────────────────────
// THEME
// ─────────────────────────────────────────

const themeDraftSchema = z.object({
  theme: storefrontThemeDocumentApiSchema,
  revision: z.number().int().nonnegative(),
  basePublishedRevision: z.number().int().nonnegative(),
  updatedAt: z.any().nullable(),
});

const themeWorkspaceSchema = z.object({
  published: z.object({
    theme: storefrontThemeDocumentApiSchema,
    revision: z.number().int().nonnegative(),
  }),
  draft: themeDraftSchema,
  draftDiffersFromLive: z.boolean(),
  lastPublished: z.object({ revision: revisionSchema, publishedBy: z.string().nullable(), publishedByName: z.string().nullable(), createdAt: z.any() }).nullable(),
});

/** An active app's storefront sections and product blocks, with the settings the editor draws for each. */
const themeAppSurfacesSchema = z.object({
  id: z.string(),
  name: z.string(),
  sections: z.array(z.object({
    /** `<app id>/<type>`: what a theme's app section names. */
    key: z.string(),
    type: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    settings: z.array(appSettingFieldSchema),
  })),
  productBlocks: z.array(z.object({
    key: z.string(),
    type: z.string(),
    name: z.string(),
    placement: z.enum(["buy-box", "below"]),
    settings: z.array(appSettingFieldSchema),
  })),
}).openapi("ThemeAppSurfaces");

const getThemeWorkspaceRoute = createRoute({
  method: "get",
  path: "/theme/workspace",
  tags: ["Admin - Settings"],
  summary: "Get published storefront style, durable draft and what the editor reads",
  operationId: "dashboard.theme.workspace_get",
  responses: {
    200: {
      description: "Theme workspace",
      content: {
        "application/json": {
          schema: successEnvelope(themeWorkspaceSchema.extend({
            /** What the theme's fit rules read, as the storefront reads it. */
            storeShape: storeShapeApiSchema,
            /** Every image the draft names (brand, hero slides, section images), for the editor's previews. */
            media: z.array(z.object({
              id: z.string(),
              url: z.string(),
              alt: z.string(),
              width: z.number().int().nullable(),
              height: z.number().int().nullable(),
            })),
            /** Sections and product blocks the store's active apps offer (the editor adds them; the apps draw them). */
            apps: z.array(themeAppSurfacesSchema),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

/** Active apps whose approved grant covers storefront surfaces, with what they offer the theme. */
async function readThemeAppSurfaces(db: Parameters<typeof listPluginInstallations>[0]) {
  const installations = await listPluginInstallations(db);
  return installations
    .filter((installation) => installation.status === "active" && installation.grant?.storefrontSurfaces === true)
    .map((installation) => {
      const { storefront, name } = installation.manifest;
      return {
        id: installation.pluginId,
        name,
        sections: storefront.sections.map((section) => ({
          key: pluginSurfaceKey(installation.pluginId, section.type),
          type: section.type,
          name: section.name,
          description: section.description ?? null,
          settings: section.settings.map(appSettingField),
        })),
        productBlocks: storefront.productBlocks.map((block) => ({
          key: pluginSurfaceKey(installation.pluginId, block.type),
          type: block.type,
          name: block.name,
          placement: block.placement,
          settings: block.settings.map(appSettingField),
        })),
      };
    })
    .filter((surfaces) => surfaces.sections.length + surfaces.productBlocks.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

app.openapi(getThemeWorkspaceRoute, async (c) => {
  const db = c.get("db");
  const [[workspace, media], storeShape, apps] = await Promise.all([
    getThemeWorkspace(db).then(async (workspace) =>
      [workspace, await readThemeMedia(db, workspace.draft.theme)] as const),
    readStoreShape(db),
    readThemeAppSurfaces(db),
  ]);
  return ok(c, { ...workspace, storeShape, media, apps });
});

const saveThemeDraftSchema = z.object({
  theme: storefrontThemeDocumentApiSchema,
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

const publishThemeDraftSchema = z.object({
  note: z.string().trim().max(500).optional(),
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
  const user = c.get("user") as { id?: string; name?: string } | undefined;
  const workspace = await publishThemeDraft(
    c.get("db"),
    body.expectedPublishedRevision,
    body.expectedDraftRevision,
    user?.id ?? null,
    body.note ?? null,
    user?.name ?? null,
  );

  return ok(c, workspace);
});

const themeVersionSchema = z.object({
  id: z.string(),
  theme: storefrontThemeDocumentApiSchema,
  revision: z.number().int().positive(),
  source: z.enum(["publish", "rollback", "migration"]),
  sourceRevision: z.number().int().positive().nullable(),
  publishedBy: z.string().nullable(),
  publishedByName: z.string().nullable(),
  summary: z.array(z.string()).max(51),
  changes: z.array(z.object({ kind: z.enum(["added", "removed", "reordered", "settings"]), page: z.string(), sectionId: z.string().optional(), path: z.string().optional() })).max(50),
  note: z.string().max(500).nullable(),
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
      limit: z.coerce.number().int().min(1).max(THEME_VERSION_HISTORY_LIMIT).default(20),
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
  summary: "Restore a published storefront style to the draft (explicit publish required)",
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
      description: "Theme version restored to draft",
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

  return ok(c, workspace);
});

const replaceThemeDraftSchema = z.object({
  expectedDraftRevision: revisionSchema,
  basePublishedRevision: revisionSchema,
});

const restoreThemeVersionRoute = createRoute({
  method: "post", path: "/theme/restore", tags: ["Admin - Settings"],
  summary: "Restore a published version only to the draft", operationId: "dashboard.theme.version_restore",
  request: { body: { required: true, content: { "application/json": { schema: replaceThemeDraftSchema.extend({ sourceRevision: z.number().int().positive() }) } } } },
  responses: { 200: { description: "Version restored to draft", content: { "application/json": { schema: successEnvelope(themeWorkspaceSchema) } } }, 409: conflictResponse, ...errorResponses },
});
app.openapi(restoreThemeVersionRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(c, await restoreThemeVersion(c.get("db"), body.sourceRevision, body.expectedDraftRevision, body.basePublishedRevision, user?.id ?? null));
});

const discardThemeDraftRoute = createRoute({
  method: "post", path: "/theme/discard", tags: ["Admin - Settings"],
  summary: "Discard draft changes and rebase to the live theme", operationId: "dashboard.theme.draft_discard",
  request: { body: { required: true, content: { "application/json": { schema: replaceThemeDraftSchema } } } },
  responses: { 200: { description: "Draft reset to live", content: { "application/json": { schema: successEnvelope(themeWorkspaceSchema) } } }, 409: conflictResponse, ...errorResponses },
});
app.openapi(discardThemeDraftRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(c, await discardThemeDraft(c.get("db"), body.expectedDraftRevision, body.basePublishedRevision, user?.id ?? null));
});

const pageDraftRevisionFields = { expectedDraftRevision: revisionSchema, basePublishedRevision: revisionSchema };
const saveThemePageDraftRoute = createRoute({
  method: "post", path: "/theme/page-draft", tags: ["Admin - Settings"],
  summary: "Edit one page template in the shared theme draft", operationId: "dashboard.theme.page_draft_update",
  request: { body: { required: true, content: { "application/json": { schema: z.discriminatedUnion("page", [
    z.object({ ...pageDraftRevisionFields, page: z.literal("home"), value: storefrontSectionListSchema }).strict(),
    z.object({ ...pageDraftRevisionFields, page: z.literal("landing"), slug: storefrontLandingSlugSchema, value: storefrontLandingPageSchema.nullable() }).strict(),
    z.object({ ...pageDraftRevisionFields, page: z.literal("product"), value: storefrontProductPageTemplateSchema }).strict(),
    z.object({ ...pageDraftRevisionFields, page: z.literal("collection"), value: storefrontListingPageTemplateSchema }).strict(),
    z.object({ ...pageDraftRevisionFields, page: z.literal("search"), value: storefrontListingPageTemplateSchema }).strict(),
  ]) } } } },
  responses: { 200: { description: "Page draft saved", content: { "application/json": { schema: successEnvelope(themeDraftSchema) } } }, 409: conflictResponse, ...errorResponses },
});
app.openapi(saveThemePageDraftRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(c, await saveThemePageDraft(c.get("db"), body.page, body.value, body.expectedDraftRevision, body.basePublishedRevision, user?.id ?? null, body.page === "landing" ? body.slug : undefined));
});

const createThemePreviewRoute = createRoute({
  method: "post",
  path: "/theme/preview-session",
  tags: ["Admin - Settings"],
  summary: "Create a short-lived storefront preview session that follows the saved draft",
  operationId: "dashboard.theme.preview_session_create",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            expectedDraftRevision: revisionSchema,
            sourceRevision: z.number().int().positive().max(2_147_483_647).optional(),
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
    body.sourceRevision ?? null,
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
// MEDIA DELIVERY
// ─────────────────────────────────────────

const MEDIA_HOST_MAX_LENGTH = 253;
const MEDIA_HOST_LIST_MAX_COUNT = 24;

const mediaOptimizationSchema = z.object({
  canonicalCdnUrl: z.string().max(MEDIA_HOST_MAX_LENGTH).default("").refine(isValidMediaHostInput, {
    message:
      "Use a hostname only, without paths, queries, wildcards, or credentials.",
  }),
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
  settings: { canonicalCdnUrl: string; canonicalHostAliases: string[] },
) {
  return {
    canonicalCdnUrl: settings.canonicalCdnUrl.slice(0, MEDIA_HOST_MAX_LENGTH),
    canonicalHostAliases: settings.canonicalHostAliases.slice(
      0,
      MEDIA_HOST_LIST_MAX_COUNT,
    ).map((host) => host.slice(0, MEDIA_HOST_MAX_LENGTH)),
  };
}
const mediaOptimizationDocumentSchema = mediaOptimizationSchema.extend({
  revision: revisionSchema,
});
const mediaOptimizationSaveResponseSchema = mediaOptimizationDocumentSchema.extend({
  message: z.string(),
});

const getMediaOptimizationRoute = createRoute({
  method: "get",
  path: "/media",
  tags: ["Admin - Settings"],
  summary: "Get media delivery host settings",
  operationId: "dashboard.settings.media_delivery_get",
  responses: {
    200: {
      description: "Media settings",
      content: {
        "application/json": {
          schema: successEnvelope(mediaOptimizationDocumentSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getMediaOptimizationRoute, async (c) => {
  const { value, revision } = await readSettingsForEdit(c.get("db"), mediaDocument);
  return ok(c, { ...projectMediaOptimizationSettings(value), revision });
});

const saveMediaOptimizationRoute = createRoute({
  method: "post",
  path: "/media",
  tags: ["Admin - Settings"],
  summary: "Save media delivery host settings",
  operationId: "dashboard.settings.media_delivery_update",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: mediaOptimizationSchema.partial().extend({ expectedRevision: revisionSchema }),
        },
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
    409: conflictResponse,
  },
});

app.openapi(saveMediaOptimizationRoute, async (c) => {
  const { expectedRevision, ...body } = c.req.valid("json");
  const saved = await saveMediaOptimizationSettings(c.get("db"), body, { expectedRevision });

  return ok(c, {
    message: "Media settings saved successfully",
    ...projectMediaOptimizationSettings(saved.value),
    revision: saved.revision,
  });
});

// ─────────────────────────────────────────
// SEO
// ─────────────────────────────────────────

const SEO_HOMEPAGE_TITLE_MAX_LENGTH = 200;
const SEO_META_DESCRIPTION_MAX_LENGTH = 1_000;
const SEO_SOCIAL_IMAGE_MAX_LENGTH = 2_048;
const SEO_FEED_TITLE_MAX_LENGTH = 200;
const SEO_FEED_DESCRIPTION_MAX_LENGTH = 2_000;
const SEO_POLICY_URL_MAX_LENGTH = 2_048;

function projectSeoSettings(
  settings: Awaited<ReturnType<typeof getSeoSettings>>,
): Awaited<ReturnType<typeof getSeoSettings>> {
  return {
    ...settings,
    homepageTitle: settings.homepageTitle.slice(0, SEO_HOMEPAGE_TITLE_MAX_LENGTH),
    homepageMetaDescription: settings.homepageMetaDescription.slice(
      0,
      SEO_META_DESCRIPTION_MAX_LENGTH,
    ),
    discovery: {
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
  revision: revisionSchema,
  homepageTitle: z.string().max(SEO_HOMEPAGE_TITLE_MAX_LENGTH),
  homepageMetaDescription: z.string().max(SEO_META_DESCRIPTION_MAX_LENGTH),
  socialImage: z.string().max(SEO_SOCIAL_IMAGE_MAX_LENGTH),
  discovery: z.object({
    feeds: z.object({
      productCatalogEnabled: z.boolean(),
      includeUnavailableProducts: z.boolean(),
      variantStrategy: z.enum(["products", "variants"]),
      title: z.string().max(SEO_FEED_TITLE_MAX_LENGTH),
      description: z.string().max(SEO_FEED_DESCRIPTION_MAX_LENGTH),
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
  const { value, revision } = await readSettingsForEdit(c.get("db"), seoDocument);
  return ok(c, { ...projectSeoSettings(value), revision });
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
  feeds: seoSettingsSchema.shape.discovery.shape.feeds.partial().optional(),
});

/** Blank, or an absolute https URL without credentials (the media library's CDN URL). */
function isValidSocialImageUrl(value: string): boolean {
  if (value === "") return true;
  return value.trim() === value && isPublicMediaUrl(value);
}

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
      "Choose one of your store's pages.",
    )
    .optional(),
});

const saveSeoSchema = z.object({
  expectedRevision: revisionSchema,
  homepageTitle: z.string().max(SEO_HOMEPAGE_TITLE_MAX_LENGTH).optional(),
  homepageMetaDescription: z
    .string()
    .max(SEO_META_DESCRIPTION_MAX_LENGTH)
    .optional(),
  socialImage: z
    .string()
    .max(SEO_SOCIAL_IMAGE_MAX_LENGTH)
    .refine(
      isValidSocialImageUrl,
      "Choose the social sharing image from Files.",
    )
    .optional(),
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
      content: { "application/json": { schema: savedRevisionResponse } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(saveSeoRoute, async (c) => {
  const { expectedRevision, ...data } = c.req.valid("json");
  const { revision } = await saveSeoSettings(c.get("db"), data, { expectedRevision });

  return ok(c, { message: "SEO settings saved successfully", revision });
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
              /** The platform document's revision (the storefront origin lives there). */
              revision: revisionSchema,
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
  const { value, revision } = await readSettingsForEdit(db, platformDocument);
  const storefrontUrl = normalizeStorefrontOrigin(value.storefrontUrl);
  return ok(c, {
    storefrontUrl:
      storefrontUrl && storefrontUrl.length <= STOREFRONT_URL_MAX_LENGTH
        ? storefrontUrl
        : "",
    revision,
  });
});

const saveStorefrontUrlSchema = z.object({
  expectedRevision: revisionSchema,
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
      content: { "application/json": { schema: savedRevisionResponse } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(saveStorefrontUrlRoute, async (c) => {
  const { storefrontUrl, expectedRevision } = c.req.valid("json");
  const { revision } = await saveStorefrontUrl(c.get("db"), storefrontUrl, c.env.CACHE, { expectedRevision });

  return ok(c, { message: "Storefront URL saved successfully", revision });
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
                revision: revisionSchema,
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
  const { value, revision } = await readSettingsForEdit(db, customerCountriesDocument);
  return ok(c, { ...projectAllowedCountries(value), revision });
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
            expectedRevision: revisionSchema,
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Countries saved",
      content: { "application/json": { schema: savedRevisionResponse } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(saveAllowedCountriesRoute, async (c) => {
  const db = c.get("db");
  const { allowedCountries, mode, expectedRevision } = c.req.valid("json");
  const projected = projectAllowedCountries({
    allowedCountries,
    allowedCountriesMode: mode,
  });
  const { revision } = await saveAllowedCountries(
    db,
    projected.allowedCountries,
    projected.allowedCountriesMode,
    { expectedRevision },
  );

  return ok(c, { message: "Allowed countries saved", revision });
});

export { app as siteSettingsRoutes };
