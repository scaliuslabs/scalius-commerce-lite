// Translations (docs/MARKETS-DESIGN.md D9; Shopify's Translate & Adapt),
// mounted at /admin/translations: every translatable resource with its source
// text and its translation in a store language (every market, or one
// market's adaptation), the Outdated fields, the localized web address, and
// machine translation through an app's translation provider (no built-in
// one). A save replaces the resource's translation in one batch; triggers
// advance the resource's `tr:` cache key.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  deleteResourceTranslation,
  getResourceTranslations,
  listTranslatableResources,
  readDefaultStoreLanguage,
  saveTranslations,
  type PaymentMethodSource,
  type TranslatableResource,
} from "@scalius/core/modules/translations";
import { listActiveProviderPlugins } from "@scalius/core/modules/plugins";
import { resolveAppProvider } from "@scalius/core/integrations/provider-port";
import { COD_LABEL, COD_PAYMENT_METHOD } from "@scalius/core/modules/payments";
import { hasPermission } from "@scalius/core/auth/rbac/helpers";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  ProviderError,
  providerErrorOf,
  qualifiedProviderId,
} from "@scalius/shared/plugins/providers";
import type { TranslatableResourceType } from "@scalius/shared/translations";
import { ok } from "../../utils/api-response";
import { ForbiddenError, ValidationError } from "../../utils/api-error";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import {
  TRANSLATION_EDITOR_TYPES,
  listTranslatableResourcesQuerySchema,
  machineTranslateSchema,
  saveTranslationSchema,
  translatableResourceSchema,
  translationContextQuerySchema,
} from "../../schemas/translations";
import { requestAppProviders } from "../../plugins/providers/app-providers";
import { requestPaymentProviders } from "../../plugins/providers/payment";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Translations";
const resourceParam = z.object({ type: z.enum(TRANSLATION_EDITOR_TYPES), id: z.string().min(1).max(128) });
const writeResponses = { ...errorResponses, 409: conflictResponse };

/** Who may translate what: the resource's own edit permission (and view to read it). */
const TRANSLATION_PERMISSIONS: Record<(typeof TRANSLATION_EDITOR_TYPES)[number], { view: string; edit: string }> = {
  product: { view: PERMISSIONS.PRODUCTS_VIEW, edit: PERMISSIONS.PRODUCTS_EDIT },
  collection: { view: PERMISSIONS.COLLECTIONS_VIEW, edit: PERMISSIONS.COLLECTIONS_EDIT },
  category: { view: PERMISSIONS.CATEGORIES_VIEW, edit: PERMISSIONS.CATEGORIES_EDIT },
  brand: { view: PERMISSIONS.CATEGORIES_VIEW, edit: PERMISSIONS.CATEGORIES_EDIT },
  page: { view: PERMISSIONS.PAGES_VIEW, edit: PERMISSIONS.PAGES_EDIT },
  menu: { view: PERMISSIONS.SETTINGS_HEADER_EDIT, edit: PERMISSIONS.SETTINGS_HEADER_EDIT },
  shipping_method: { view: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW, edit: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  payment_method: { view: PERMISSIONS.SETTINGS_GENERAL_VIEW, edit: PERMISSIONS.SETTINGS_GENERAL_EDIT },
};

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

async function assertMay(c: Context<{ Bindings: Env }>, type: (typeof TRANSLATION_EDITOR_TYPES)[number], action: "view" | "edit"): Promise<void> {
  const user = c.get("user") as { id?: string } | undefined;
  const permission = TRANSLATION_PERMISSIONS[type][action];
  if (!user?.id || !await hasPermission(c.get("db"), user.id, permission, c.env.CACHE)) {
    throw new ForbiddenError(action === "view" ? "You don't have permission to see this kind of resource." : "You don't have permission to edit this kind of resource.");
  }
}

/** Payment methods are code: their names as checkout shows them (built-in gateways, cash on delivery, active apps). */
async function paymentMethodSources(c: Context<{ Bindings: Env }>): Promise<PaymentMethodSource[]> {
  const providers = await requestPaymentProviders(c);
  return providers.methodIds().map((id) => ({
    id,
    name: id === COD_PAYMENT_METHOD ? COD_LABEL : providers.get(id)?.checkoutName ?? providers.label(id),
  }));
}

function presentResource(resource: TranslatableResource) {
  return {
    ...resource,
    source: Object.fromEntries(Object.entries(resource.source).map(([field, value]) => [field, value ?? null])) as Record<string, string | null>,
    translation: resource.translation
      ? { ...resource.translation, updatedAt: resource.translation.updatedAt ? new Date(resource.translation.updatedAt).toISOString() : null }
      : null,
  };
}

app.openapi(createRoute({
  operationId: "dashboard.translations.list",
  method: "get",
  path: "/resources",
  tags: [TAG],
  summary: "One page of a resource type with its translation status in a language",
  description: "Products, collections, categories, brands, pages (and articles), menus, delivery rates or payment methods, by title, with each one's status in the language (and market): translated, outdated (its source changed since), partial or untranslated.",
  request: { query: listTranslatableResourcesQuerySchema },
  responses: {
    200: {
      description: "The page",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            items: z.array(translatableResourceSchema),
            total: z.number().int(),
            page: z.number().int(),
            limit: z.number().int(),
          })),
        },
      },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const query = c.req.valid("query");
  await assertMay(c, query.type, "view");
  const result = await listTranslatableResources(c.get("db"), query.type, {
    ...query,
    paymentMethods: query.type === "payment_method" ? await paymentMethodSources(c) : undefined,
  });
  return ok(c, { ...result, items: result.items.map(presentResource) });
});

app.openapi(createRoute({
  operationId: "dashboard.translations.providers",
  method: "get",
  path: "/providers",
  tags: [TAG],
  summary: "The machine translation providers of active apps",
  description: "Scalius has no built-in translation provider: an app provides one (`translate`). Empty when no active app does.",
  responses: {
    200: {
      description: "Providers",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            items: z.array(z.object({ id: z.string(), name: z.string(), appName: z.string() })),
            defaultLocale: z.string(),
          })),
        },
      },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const [installations, defaultLocale] = await Promise.all([
    listActiveProviderPlugins(db, "translation"),
    readDefaultStoreLanguage(db),
  ]);
  const items = installations.flatMap((installation) => installation.manifest.providers
    .filter((provider) => provider.kind === "translation")
    .map((provider) => ({ id: qualifiedProviderId(installation.pluginId, provider.id), name: provider.name, appName: installation.manifest.name })));
  return ok(c, { items, defaultLocale });
});

app.openapi(createRoute({
  operationId: "dashboard.translations.machine_translate",
  method: "post",
  path: "/machine",
  tags: [TAG],
  summary: "Translate text with an app's translation provider",
  description: "Sends up to 100 texts in the store default language to the provider and returns its translations into `locale`. Nothing is saved: the editor fills the fields for the merchant to review and save.",
  request: { body: { required: true, content: { "application/json": { schema: machineTranslateSchema } } } },
  responses: {
    200: {
      description: "The translations",
      content: { "application/json": { schema: successEnvelope(z.object({ texts: z.array(z.object({ key: z.string(), text: z.string() })) })) } },
    },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const input = c.req.valid("json");
  const db = c.get("db");
  const choice = await resolveAppProvider(requestAppProviders(c), "translation", input.providerId);
  if (!choice.provider) throw new ValidationError(choice.issue);
  const sourceLocale = await readDefaultStoreLanguage(db);
  if (sourceLocale === input.locale) throw new ValidationError("Choose a language other than the default language: it is the source text.");
  try {
    const result = await choice.provider.translate({ sourceLocale, targetLocale: input.locale, texts: input.texts }, {});
    return ok(c, { texts: result.texts });
  } catch (error) {
    const providerError = providerErrorOf(error);
    if (providerError) throw new ValidationError(`${choice.provider.label}: ${providerError.message}`);
    throw new ValidationError(`${choice.provider.label} could not translate the text. Try again.`, error instanceof ProviderError ? { code: error.code } : undefined);
  }
});

app.openapi(createRoute({
  operationId: "dashboard.translations.get",
  method: "get",
  path: "/{type}/{id}",
  tags: [TAG],
  summary: "A resource's source text and its translation in a language",
  description: "With the Outdated fields and the localized web address; a product with its options and option values (`parts`).",
  request: { params: resourceParam, query: translationContextQuerySchema },
  responses: {
    200: {
      description: "The resource",
      content: { "application/json": { schema: successEnvelope(z.object({ resource: translatableResourceSchema, parts: z.array(translatableResourceSchema) })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const { type, id } = c.req.valid("param");
  await assertMay(c, type, "view");
  const view = await getResourceTranslations(c.get("db"), type, id, {
    ...c.req.valid("query"),
    paymentMethods: type === "payment_method" ? await paymentMethodSources(c) : undefined,
  });
  return ok(c, { resource: presentResource(view.resource), parts: view.parts.map(presentResource) });
});

app.openapi(createRoute({
  operationId: "dashboard.translations.save",
  method: "put",
  path: "/{type}/{id}",
  tags: [TAG],
  summary: "Save a resource's translation in a language",
  description: "Replaces the translation of the resource (and a product's options and option values in `parts`) in the language and market: fields left out or empty fall back to the source. Each field records the source it was translated from, so a later source edit marks it Outdated. `slug` sets the localized web address (every-market translations only); a handle another page of the type uses is refused (409).",
  request: {
    params: resourceParam,
    body: { required: true, content: { "application/json": { schema: saveTranslationSchema } } },
  },
  responses: {
    200: {
      description: "The saved resource",
      content: { "application/json": { schema: successEnvelope(z.object({ resource: translatableResourceSchema, parts: z.array(translatableResourceSchema) })) } },
    },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { type, id } = c.req.valid("param");
  await assertMay(c, type, "edit");
  const body = c.req.valid("json");
  if (body.parts?.length && type !== "product") throw new ValidationError("Only a product has parts to translate with it.");
  const db = c.get("db");
  const paymentMethods = type === "payment_method" ? await paymentMethodSources(c) : undefined;
  await saveTranslations(db, {
    locale: body.locale,
    marketId: body.marketId ?? null,
    paymentMethods,
    entries: [
      { type: type as TranslatableResourceType, id, fields: body.fields, ...(body.slug !== undefined ? { slug: body.slug } : {}) },
      ...(body.parts ?? []).map((part) => ({ type: part.type as TranslatableResourceType, id: part.id, fields: part.fields })),
    ],
  });
  const view = await getResourceTranslations(db, type, id, { locale: body.locale, marketId: body.marketId ?? null, paymentMethods });
  return ok(c, { resource: presentResource(view.resource), parts: view.parts.map(presentResource) });
});

app.openapi(createRoute({
  operationId: "dashboard.translations.delete",
  method: "delete",
  path: "/{type}/{id}",
  tags: [TAG],
  summary: "Delete a resource's translation in a language",
  description: "Buyers then read the source text in that language (and market). An every-market deletion also removes the localized web address.",
  request: { params: resourceParam, query: translationContextQuerySchema },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ type: z.string(), id: z.string() })) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { type, id } = c.req.valid("param");
  await assertMay(c, type, "edit");
  await deleteResourceTranslation(c.get("db"), type, id, c.req.valid("query"));
  return ok(c, { type, id });
});

export { app as adminTranslationRoutes };
