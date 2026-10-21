// Settings → Languages (docs/MARKETS-DESIGN.md D9), mounted at
// /admin/settings/languages: the one list of the store's languages
// (Shopify's Languages). The default language is the store's own URL (the
// backup market's root presence); a market's web address names a language,
// and only a published language's addresses are served. The database keeps
// the default language published and refuses removing a language a web
// address uses.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  addStoreLanguage,
  getStoreLanguage,
  listStoreLanguages,
  removeStoreLanguage,
  setDefaultStoreLanguage,
  setStoreLanguagePublished,
} from "@scalius/core/modules/translations";
import { created, ok } from "../../../utils/api-response";
import { boundedPage, boundedPageQuery, nextCursorSchema } from "../../../utils/bounded-page";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";
import {
  createStoreLanguageSchema,
  storeLanguageLocaleParam,
  storeLanguageSchema,
  updateStoreLanguageSchema,
} from "../../../schemas/translations";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Languages";
/** ISO 639-1 has fewer two-letter codes than this. */
const LANGUAGES_BOUND = 200;
const languageEnvelope = successEnvelope(z.object({ language: storeLanguageSchema }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

app.openapi(createRoute({
  operationId: "dashboard.languages.list",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "The store's languages: the default first",
  description: "Each language with whether it is published, whether it is the default (the store's own URL and the source text), the market web addresses in it and how many resources have a translation in it. The default comes first, then the others by code.",
  request: { query: z.object(boundedPageQuery(LANGUAGES_BOUND)) },
  responses: {
    200: { description: "Languages", content: { "application/json": { schema: successEnvelope(z.object({ languages: z.array(storeLanguageSchema), nextCursor: nextCursorSchema })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const query = c.req.valid("query");
  const order = (language: { isDefault: boolean; locale: string }) => `${language.isDefault ? 0 : 1}:${language.locale}`;
  const languages = (await listStoreLanguages(c.get("db"))).sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const page = boundedPage(languages, {
    name: "languages",
    cursor: query.cursor,
    limit: query.limit,
    id: (language) => language.locale,
    sort: { kind: "text", value: order },
  });
  return ok(c, { languages: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.languages.create",
  method: "post",
  path: "/",
  tags: [TAG],
  summary: "Add a language",
  description: "A new language is unpublished unless `published` is true: translate the store first, then publish it and give a market a web address in it (Settings → Markets). At most 20 published languages.",
  request: { body: { required: true, content: { "application/json": { schema: createStoreLanguageSchema } } } },
  responses: {
    201: { description: "The new language", content: { "application/json": { schema: languageEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  return created(c, { language: await addStoreLanguage(c.get("db"), c.req.valid("json")) });
});

app.openapi(createRoute({
  operationId: "dashboard.languages.update",
  method: "patch",
  path: "/{locale}",
  tags: [TAG],
  summary: "Publish, unpublish or make a language the default",
  description: "`published: false` takes the language's market web addresses offline (the default language is always published). `isDefault: true` makes it the language of the store's own URL and publishes it; the checkout copy in use follows it.",
  request: {
    params: storeLanguageLocaleParam,
    body: { required: true, content: { "application/json": { schema: updateStoreLanguageSchema } } },
  },
  responses: {
    200: { description: "The language", content: { "application/json": { schema: languageEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const { locale } = c.req.valid("param");
  const { published, isDefault } = c.req.valid("json");
  if (isDefault) await setDefaultStoreLanguage(db, locale);
  if (published !== undefined) await setStoreLanguagePublished(db, locale, published);
  return ok(c, { language: await getStoreLanguage(db, locale) });
});

app.openapi(createRoute({
  operationId: "dashboard.languages.delete",
  method: "delete",
  path: "/{locale}",
  tags: [TAG],
  summary: "Remove a language with its translations",
  description: "Deletes the language, every translation and localized web address in it. Refused while a market's web address uses it (409).",
  request: { params: storeLanguageLocaleParam },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: successEnvelope(z.object({ locale: z.string() })) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { locale } = c.req.valid("param");
  await removeStoreLanguage(c.get("db"), locale);
  return ok(c, { locale });
});

export { app as languagesSettingsRoutes };
