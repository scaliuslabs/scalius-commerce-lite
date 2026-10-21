// Address autocomplete at checkout (packages/plugin-sdk/docs/apps.md, "Providers",
// address), mounted at /address-rules/autocomplete: suggestions from the
// store's address app as the buyer types, then one suggestion as the
// canonical address fields (`@scalius/shared/address`) the form fills. The
// form still validates by the country's rules; a suggestion never skips
// that. The typed words are buyer data, so they travel in a POST body,
// never a URL, and are never cached or logged. No app, an app that is not
// ready, or a failing one answers no suggestions: the buyer types the
// address as without autocomplete.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { resolveAppProvider } from "@scalius/core/integrations/provider-port";
import { providerServesCountry } from "@scalius/shared/plugins/providers";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { getClientIp } from "@scalius/shared/rate-limit";
import { requestAppProviders } from "../plugins/providers/app-providers";
import { RateLimitError } from "../utils/api-error";
import { ok } from "../utils/api-response";
import { isWithinRateLimit } from "../utils/rate-limit";
import { errorResponses, successEnvelope } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Address autocomplete";
/** A buyer waits at most this long for suggestions. */
const ADDRESS_APP_WAIT_MS = 1_500;

const base = {
  provider: z.string().max(160).openapi({ description: "The store's address app (`layout.appServices.address.id`)." }),
  country: z.string().regex(/^[A-Z]{2}$/),
  locale: z.string().regex(/^[a-z]{2}$/).default("en"),
  sessionToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).openapi({ description: "Random per address form; groups one buyer's calls for the provider." }),
};

const suggestionSchema = z.object({ id: z.string(), text: z.string(), secondaryText: z.string().optional() });
const addressSchema = z.object({
  countryCode: z.string(),
  line1: z.string().optional(),
  line2: z.string().optional(),
  dependentLocality: z.string().optional(),
  locality: z.string().optional(),
  adminArea: z.string().optional(),
  postalCode: z.string().optional(),
});

async function guard(c: Context<{ Bindings: Env }>) {
  c.header("Cache-Control", "private, no-store");
  if (!(await isWithinRateLimit(c.env, "RL_STANDARD", "address-autocomplete", getClientIp(c.req.raw)))) {
    throw new RateLimitError("Too many requests. Please try again later.");
  }
}

/** The ready address app for this country, or null (no suggestions). */
async function addressApp(c: Context<{ Bindings: Env }>, providerId: string, country: string) {
  if (!isQualifiedProviderId(providerId)) return null;
  const choice = await resolveAppProvider(requestAppProviders(c), "address", providerId).catch(() => null);
  if (!choice?.provider || !providerServesCountry(choice.provider.countries, country)) return null;
  return choice.provider;
}

/** Runs one provider call with the buyer's wait limit; null on any failure. */
async function withinWait<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADDRESS_APP_WAIT_MS);
  try {
    return await call(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

app.openapi(createRoute({
  operationId: "storefront.address_autocomplete.suggest",
  method: "post",
  path: "/suggest",
  tags: [TAG],
  summary: "Address suggestions for what the buyer typed",
  description: "Empty when the store has no ready address app for the country, or it is slow or failing.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ ...base, query: z.string().trim().min(3).max(200) }).strict() } } } },
  responses: {
    200: { description: "Suggestions", content: { "application/json": { schema: successEnvelope(z.object({ suggestions: z.array(suggestionSchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  await guard(c);
  const input = c.req.valid("json");
  const provider = await addressApp(c, input.provider, input.country);
  const answer = provider
    ? await withinWait((signal) => provider.suggest({ query: input.query, country: input.country, locale: input.locale, sessionToken: input.sessionToken }, { signal }))
    : null;
  return ok(c, { suggestions: answer?.suggestions ?? [] });
});

app.openapi(createRoute({
  operationId: "storefront.address_autocomplete.resolve",
  method: "post",
  path: "/resolve",
  tags: [TAG],
  summary: "One suggestion as address fields",
  description: "The canonical address fields of the chosen suggestion; null when the app cannot answer. The form validates them by the country's rules.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ ...base, id: z.string().min(1).max(512) }).strict() } } } },
  responses: {
    200: { description: "The address", content: { "application/json": { schema: successEnvelope(z.object({ address: addressSchema.nullable() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  await guard(c);
  const input = c.req.valid("json");
  const provider = await addressApp(c, input.provider, input.country);
  const answer = provider
    ? await withinWait((signal) => provider.resolve({ id: input.id, country: input.country, locale: input.locale, sessionToken: input.sessionToken }, { signal }))
    : null;
  // An answer for another country is not this form's address.
  return ok(c, { address: answer && answer.address.countryCode === input.country ? answer.address : null });
});

export { app as addressAutocompleteRoutes };
