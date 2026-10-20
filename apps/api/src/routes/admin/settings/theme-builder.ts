// The theme builder's own operations beside the theme workflow in site.ts:
// restore points (the draft as it was before a restore or a discard), AI
// drafting through an app's AI provider, and drafted sections an agent adds
// to the shared draft. Every drafted section is validated against the
// theme's section schemas before it can reach a draft; none goes live
// until someone publishes.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  STOREFRONT_PAGE_TEMPLATES,
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_RENDERERS,
  storefrontLandingSlugSchema,
} from "@scalius/shared/storefront-theme";
import {
  AI_GENERATE_PROMPT_MAX,
  qualifiedProviderId,
} from "@scalius/shared/plugins/providers";
import { ValidationError } from "@scalius/core/errors";
import { resolveAppProvider } from "@scalius/core/integrations/provider-port";
import { listActiveProviderPlugins } from "@scalius/core/modules/plugins";
import {
  THEME_DRAFT_SECTIONS_MAX,
  THEME_RESTORE_POINT_LIMIT,
  acceptDraftedSections,
  draftThemeSections,
  listThemeRestorePoints,
  restoreThemeRestorePoint,
} from "@scalius/core/modules/settings";
import { requestAppProviders } from "../../../plugins/providers/app-providers";
import { ok } from "../../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";
import { storefrontSectionListApiSchema } from "../../../schemas/storefront-theme";
import { boundedThemeStatus, themeDraftReceiptSchema, themeStatusSchema, themeIso } from "./theme-contract";

const app = new OpenAPIHono<{ Bindings: Env }>();
const revisionSchema = z.number().int().nonnegative();
const draftRevisionFields = { expectedDraftRevision: revisionSchema, basePublishedRevision: revisionSchema };

// ─── Restore points ──────────────────────────────────────────────────────────

const restorePointSchema = z.object({
  id: z.string().max(40),
  reason: z.enum(["restore", "discard"]),
  draftRevision: z.number().int().positive(),
  createdBy: z.string().max(160).nullable(),
  createdByName: z.string().max(200).nullable(),
  createdAt: z.string().openapi({ format: "date-time" }),
}).openapi("ThemeRestorePoint");

app.openapi(createRoute({
  method: "get",
  path: "/theme/restore-points",
  tags: ["Admin - Settings"],
  summary: "List the theme draft's restore points, newest first",
  description: `The shared draft as it was just before each restore or discard replaced it (the newest ${THEME_RESTORE_POINT_LIMIT} are kept). Read one with \`document_get\` (\`source=restore-point\`), put it back with \`draft_snapshot_restore\`.`,
  operationId: "dashboard.theme.draft_snapshots_list",
  responses: {
    200: {
      description: "Restore points",
      content: { "application/json": { schema: successEnvelope(z.object({ restorePoints: z.array(restorePointSchema).max(THEME_RESTORE_POINT_LIMIT) })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const points = await listThemeRestorePoints(c.get("db"));
  return ok(c, {
    restorePoints: points.map((point) => ({
      ...point,
      createdBy: point.createdBy?.slice(0, 160) ?? null,
      createdByName: point.createdByName?.slice(0, 200) ?? null,
      createdAt: themeIso(point.createdAt),
    })),
  });
});

app.openapi(createRoute({
  method: "post",
  path: "/theme/restore-point",
  tags: ["Admin - Settings"],
  summary: "Put a restore point back in the draft (it goes live only when the draft is published)",
  description: "The draft it replaces becomes a restore point too, so the restore can be undone. A point that names images deleted from Files since is refused with THEME_VERSION_IMAGES_MISSING; send withoutMissingImages to restore it without them.",
  operationId: "dashboard.theme.draft_snapshot_restore",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            ...draftRevisionFields,
            id: z.string().regex(/^themerp_[A-Za-z0-9_-]{4,32}$/),
            withoutMissingImages: z.boolean().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "Theme revisions", content: { "application/json": { schema: successEnvelope(themeStatusSchema) } } },
    409: conflictResponse,
    ...errorResponses,
  },
}), async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  return ok(c, boundedThemeStatus(await restoreThemeRestorePoint(
    c.get("db"), body.id, body.expectedDraftRevision, body.basePublishedRevision, user?.id ?? null,
    { withoutMissingImages: body.withoutMissingImages === true },
  )));
});

// ─── AI drafting ─────────────────────────────────────────────────────────────

/** What each section type is for, in a line the model reads beside its settings. */
const SECTION_PURPOSE: Record<(typeof STOREFRONT_SECTION_RENDERERS)[number], string> = {
  hero: "A banner slider at the top of a page. Each slide needs an image (a media id from Files), so leave slides empty when you have none.",
  "usp_strip": "A strip of short selling points (delivery, returns, payment), from the store's delivery facts or the merchant's own.",
  "category_tiles": "Tiles that link to the store's categories (category ids).",
  collections: "Rows of products from collections (collection ids).",
  "product_rail": "A scrolling row of products from a source (newest, on sale, popular, a category or a collection).",
  "product_grid": "A grid of products from a source.",
  "deal_block": "A flash-sale row of products, with a countdown to a real promotion's end.",
  "product_tabs": "Two to four tabs, each a product source.",
  lookbook: "A lifestyle photo beside a grid of products.",
  banner: "One campaign banner: heading, text, optional image and button.",
  "shop_by": "Image cards that each link somewhere (each needs an image).",
  "banner_mosaic": "A mosaic of linked promo images (each needs an image).",
  "brand_wall": "The store's brands as a wall or rail.",
  editorial: "Words: rich text, image with text, columns or testimonials.",
  faq: "Questions and answers.",
  specifications: "Product details as label and value rows, optionally connected to the product's custom fields.",
  "utility_cards": "Small link cards (track an order, contact us).",
  "endless_grid": "A long grid of the newest products that keeps loading.",
  "seo_text": "Long copy below everything, for search engines and readers.",
  "recently_viewed": "The products this buyer viewed (filled in their browser).",
  objects: "The published entries of one content type (an FAQ, a size chart, store locations): a content type id from Content types; leave it empty when you have none.",
  newsletter: "A signup: phone always, e-mail as chosen, optional WhatsApp.",
};

/** Most sections one AI draft returns. */
const AI_DRAFT_SECTIONS_MAX = 8;

/**
 * The JSON Schema of a draft: `{ sections, note }`, each section one of the
 * types a page may use with that type's settings schema. The AI port is
 * general (`generate`); this schema and the instructions make it a section
 * drafter, and the answer is validated against the theme's own schemas.
 */
function aiDraftSchema(limit: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["sections"],
    properties: {
      sections: {
        type: "array",
        maxItems: limit,
        items: {
          anyOf: STOREFRONT_SECTION_RENDERERS.map((type) => ({
            type: "object",
            description: SECTION_PURPOSE[type],
            additionalProperties: false,
            required: ["type", "settings"],
            properties: {
              type: { const: type },
              settings: z.toJSONSchema(STOREFRONT_SECTION_REGISTRY[type].settings, { unrepresentable: "any" }),
            },
          })),
        },
      },
      note: { type: "string", maxLength: 500, description: "One short line for the merchant: what the draft did and what to check." },
    },
  };
}

const AI_PAGE_NAMES = { home: "the homepage", landing: "a landing page", product: "product pages", collection: "category and collection pages", cart: "the cart page", page: "content pages" } as const;

function aiDraftInstructions(page: keyof typeof AI_PAGE_NAMES, limit: number): string {
  return [
    `Draft at most ${limit} storefront sections for ${AI_PAGE_NAMES[page]} of an online store, from the merchant's words.`,
    "Answer with one JSON value that matches the schema: each section is a `type` and its `settings`.",
    "Write every word in the language the request names. Use only facts the merchant gave; never invent prices, discounts, deadlines, reviews or contact details.",
    "Images, products, categories and collections are ids you do not have: leave image fields empty or choose a section that needs none, and use product sources such as newest or on sale.",
  ].join("\n");
}

const aiDraftValueSchema = z.object({
  sections: z.array(z.record(z.string(), z.unknown())).max(AI_DRAFT_SECTIONS_MAX),
  note: z.string().max(500).optional(),
});

const aiPageSchema = z.enum(["home", "landing", ...STOREFRONT_PAGE_TEMPLATES]);

app.openapi(createRoute({
  method: "post",
  path: "/theme/ai-draft",
  tags: ["Admin - Settings"],
  summary: "Draft theme sections from the merchant's words with an app's AI provider",
  description: `Scalius has no built-in AI and no model key: an app's AI provider (the general \`generate\` port) drafts against the section schemas. Returns up to ${AI_DRAFT_SECTIONS_MAX} sections, each validated against the theme's section schemas and marked as an AI draft; invalid ones are left out and counted. Nothing is saved: the editor adds them to its unsaved draft.`,
  operationId: "dashboard.theme.ai_draft_create",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            providerId: z.string().min(3).max(120),
            prompt: z.string().trim().min(1).max(AI_GENERATE_PROMPT_MAX),
            page: aiPageSchema,
            locale: z.string().regex(/^[a-z]{2}$/).default("en"),
            limit: z.number().int().min(1).max(AI_DRAFT_SECTIONS_MAX).default(3),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Drafted sections",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            sections: storefrontSectionListApiSchema,
            /** Sections the provider returned that were not valid sections of this theme. */
            rejected: z.number().int().nonnegative(),
            note: z.string().max(500).nullable(),
          })),
        },
      },
    },
    ...errorResponses,
  },
}), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const input = c.req.valid("json");
  const choice = await resolveAppProvider(requestAppProviders(c), "ai", input.providerId);
  if (!choice.provider) throw new ValidationError(choice.issue);
  // Loaded only when someone drafts: a store without an AI app never runs it.
  const { AiGenerateError, generateStructured } = await import("@scalius/core/integrations/ai-generate");
  let value: z.output<typeof aiDraftValueSchema>;
  try {
    value = await generateStructured(choice.provider, {
      purpose: "theme.sections",
      instructions: aiDraftInstructions(input.page, input.limit),
      prompt: input.prompt,
      locale: input.locale,
      schema: aiDraftValueSchema,
      jsonSchema: aiDraftSchema(input.limit),
      signal: c.req.raw.signal,
    });
  } catch (error) {
    if (error instanceof AiGenerateError) throw new ValidationError(error.message, { code: `ai.${error.reason}` });
    throw error;
  }
  // Every section is checked against the theme's own schemas; one that fails is left out and counted.
  const accepted = acceptDraftedSections(value.sections.slice(0, input.limit), []);
  if (accepted.sections.length === 0) {
    throw new ValidationError(`${choice.provider.label} returned nothing this theme can show. Try other words.`, { code: "ai.invalid_output" });
  }
  return ok(c, { sections: accepted.sections, rejected: accepted.rejected, note: value.note ?? null });
});

app.openapi(createRoute({
  method: "get",
  path: "/theme/ai-providers",
  tags: ["Admin - Settings"],
  summary: "The AI providers of active apps (the theme editor's Draft with AI)",
  description: "Scalius has no built-in AI provider: an app provides one. Empty when no active app does; agents connected to the store can draft sections with `draft_sections` instead.",
  operationId: "dashboard.theme.ai_providers_list",
  responses: {
    200: {
      description: "Providers",
      content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), appName: z.string(), appId: z.string() })) })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const installations = await listActiveProviderPlugins(c.get("db"), "ai");
  const items = installations.flatMap((installation) => installation.manifest.providers
    .filter((provider) => provider.kind === "ai")
    .map((provider) => ({ id: qualifiedProviderId(installation.pluginId, provider.id), name: provider.name, appName: installation.manifest.name, appId: installation.pluginId })));
  return ok(c, { items });
});

// ─── Drafted sections (agents) ───────────────────────────────────────────────

const draftScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home") }).strict(),
  z.object({ kind: z.literal("landing"), slug: storefrontLandingSlugSchema }).strict(),
  z.object({ kind: z.literal("template"), template: z.enum(STOREFRONT_PAGE_TEMPLATES), region: z.enum(["before", "after"]) }).strict(),
]);

app.openapi(createRoute({
  method: "post",
  path: "/theme/draft-sections",
  tags: ["Admin - Settings"],
  summary: "Add drafted sections to the shared theme draft (an AI's draft for the merchant to review)",
  description: `Adds up to ${THEME_DRAFT_SECTIONS_MAX} sections to a page of the shared draft: the homepage, a landing page, or a template before or after its fixed part, after \`afterId\` or at the end. Each is \`{ type, settings }\` from the section registry (read the draft with \`document_get\` to see the shapes); invalid ones are left out and counted, app sections are not accepted. The sections are marked as AI drafts until someone opens them in the editor, and the publish summary names them. Nothing goes live until someone publishes.`,
  operationId: "dashboard.theme.draft_sections",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            ...draftRevisionFields,
            scope: draftScopeSchema,
            afterId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable().optional(),
            sections: z.array(z.record(z.string(), z.unknown())).min(1).max(THEME_DRAFT_SECTIONS_MAX),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Sections drafted",
      content: {
        "application/json": {
          schema: successEnvelope(themeDraftReceiptSchema.extend({
            added: z.array(z.string()).max(THEME_DRAFT_SECTIONS_MAX),
            rejected: z.number().int().nonnegative(),
          })),
        },
      },
    },
    409: conflictResponse,
    ...errorResponses,
  },
}), async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  const result = await draftThemeSections(
    c.get("db"),
    { scope: body.scope, sections: body.sections, afterId: body.afterId ?? null },
    body.expectedDraftRevision,
    body.basePublishedRevision,
    user?.id ?? null,
  );
  return ok(c, {
    revision: result.revision,
    basePublishedRevision: result.basePublishedRevision,
    updatedAt: result.updatedAt && themeIso(result.updatedAt),
    added: result.added,
    rejected: result.rejected,
  });
});

export { app as themeBuilderRoutes };
