// Settings → Markets (docs/MARKETS-DESIGN.md D4), mounted at
// /admin/settings/markets. A market is its row, countries and presences under
// one revision; the database keeps one backup market, one market per country
// and the root URL for the backup alone. Triggers advance the market cache
// keys and the checkout authority fence in the write transaction. A change of
// the backup market's price increment queues a catalogue projection rebuild,
// because card prices round to it.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createMarket, deleteMarket, getMarket, listMarkets, listOwnMarketCurrencies, readStoreCurrency, updateMarket } from "@scalius/core/modules/markets";
import { getActivePaymentMethods } from "@scalius/core/modules/payments";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { MANUAL_FX_RATE_SOURCE_ID } from "@scalius/shared/market-pricing";
import { ValidationError } from "../../../utils/api-error";
import { appFxRateSource } from "../../../plugins/providers/fx";
import { assertAppProviderInstalled, requestAppProviders } from "../../../plugins/providers/app-providers";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { requestPaymentProviders } from "../../../plugins/providers/payment";
import { created, ok } from "../../../utils/api-response";
import { rebuildCatalogProjectionsAfterWrite } from "../../../background/catalog";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";
import { createMarketSchema, marketPricingInput, marketRecordSchema, presentMarket, updateMarketSchema } from "../../../schemas/markets";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Markets";
const marketParam = z.object({ id: z.string().min(1).max(64) });
const marketEnvelope = successEnvelope(z.object({ market: marketRecordSchema }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

app.openapi(createRoute({
  operationId: "dashboard.markets.list",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "Markets: the backup market first, then by name",
  description: "Each market with its status, countries, currency and web presence. The backup market sells in the shop currency; another market sells in it or in its own currency.",
  responses: {
    200: { description: "Markets", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(marketRecordSchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { items: (await listMarkets(c.get("db"))).map(presentMarket) });
});

app.openapi(createRoute({
  operationId: "dashboard.markets.currencies",
  method: "get",
  path: "/currencies",
  tags: [TAG],
  summary: "The currencies a market can sell in",
  description: "The shop currency, the currencies the store's active payment methods can charge (`any` when one charges every currency) and the currencies markets sell in now. A market may sell in its own currency only when an active payment method charges it (MARKETS-DESIGN step 6).",
  responses: {
    200: {
      description: "Market currencies",
      content: { "application/json": { schema: successEnvelope(z.object({
        shopCurrencyCode: z.string(),
        chargeable: z.union([z.literal("any"), z.array(z.string())]),
        marketCurrencies: z.array(z.string()),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const [currency, chargeable, marketCurrencies] = await Promise.all([
    readStoreCurrency(db),
    chargeableCurrencies(c, db),
    listOwnMarketCurrencies(db),
  ]);
  return ok(c, { shopCurrencyCode: currency.code, chargeable: chargeable === "any" ? "any" as const : [...chargeable], marketCurrencies });
});

app.openapi(createRoute({
  operationId: "dashboard.markets.get",
  method: "get",
  path: "/{id}",
  tags: [TAG],
  summary: "One market",
  request: { params: marketParam },
  responses: {
    200: { description: "The market", content: { "application/json": { schema: marketEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { market: presentMarket(await getMarket(c.get("db"), c.req.valid("param").id)) });
});

app.openapi(createRoute({
  operationId: "dashboard.markets.create",
  method: "post",
  path: "/",
  tags: [TAG],
  summary: "Create a market",
  description: "A market sells to its countries (each country belongs to one market) and can have a subfolder presence such as /en-in. Only active markets resolve for buyers.",
  request: { body: { required: true, content: { "application/json": { schema: createMarketSchema } } } },
  responses: {
    201: { description: "The new market", content: { "application/json": { schema: marketEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const market = await createMarket(c.get("db"), c.req.valid("json"));
  return created(c, { market: presentMarket(market) });
});

app.openapi(createRoute({
  operationId: "dashboard.markets.update",
  method: "patch",
  path: "/{id}",
  tags: [TAG],
  summary: "Edit a market under the revision the editor loaded",
  description: "Fields left out keep their value. The backup market stays active at the root URL, sells in the shop currency and alone sets a price increment. Another market may sell in its own currency (one an active payment method charges) at its exchange rate, and may price by FX: product prices converted, adjusted by a percentage, rounded up to a step and ending in an amount (MARKETS-DESIGN D5, step 6). A currency change makes open checkouts price again in the new currency.",
  request: {
    params: marketParam,
    body: { required: true, content: { "application/json": { schema: updateMarketSchema } } },
  },
  responses: {
    200: { description: "The saved market", content: { "application/json": { schema: marketEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { priceMode, fxRate: manualRate, priceAdjustmentPercent, priceRounding, priceEnding, ...body } = c.req.valid("json");
  const db = c.get("db");
  const id = c.req.valid("param").id;
  // Pricing amounts arrive in major units of the currency the market will sell in.
  const amounts = priceRounding !== undefined || priceEnding !== undefined;
  const appSource = body.fxRateSource !== undefined && body.fxRateSource !== MANUAL_FX_RATE_SOURCE_ID;
  const current = amounts || body.currencyCode || appSource || manualRate !== undefined ? await getMarket(db, id) : null;
  const currencyCode = body.currencyCode !== undefined
    ? normalizeSupportedCurrencyCode(body.currencyCode) ?? current?.shopCurrencyCode ?? "BDT"
    : current?.currencyCode ?? "BDT";
  // An app sets the rate: it is asked now (the save fails without an answer), and a typed rate is ignored.
  const nextSource = body.fxRateSource ?? current?.fxRateSource ?? MANUAL_FX_RATE_SOURCE_ID;
  const fxRate = appSource && current
    ? await appFxRateNow(c, body.fxRateSource!, current.shopCurrencyCode, currencyCode)
    : nextSource === MANUAL_FX_RATE_SOURCE_ID ? manualRate : undefined;
  const pricing = marketPricingInput({ priceMode, fxRate, priceAdjustmentPercent, priceRounding, priceEnding }, currencyCode);
  // A market's own currency must be one an active payment method charges.
  const chargeable = body.currencyCode
    ? await chargeableCurrencies(c, db)
    : "any" as const;
  const { market, priceIncrementChanged } = await updateMarket(db, id, { ...body, ...pricing }, { chargeable });
  if (priceIncrementChanged) {
    // Card prices in the catalogue projections round to the increment.
    await rebuildCatalogProjectionsAfterWrite(c, c.get("db"), "markets");
  }
  return ok(c, { market: presentMarket(market) });
});

/** The exchange rate app's rate for the market currency now, or the merchant-facing reason it has none. */
async function appFxRateNow(c: Context<{ Bindings: Env }>, sourceId: string, shopCurrencyCode: string, currencyCode: string): Promise<string> {
  await assertAppProviderInstalled(c.get("db"), "fx", sourceId);
  const source = await appFxRateSource(requestAppProviders(c), sourceId);
  if ("issue" in source) throw new ValidationError(source.issue);
  if (currencyCode === shopCurrencyCode) throw new ValidationError(`This market sells in ${shopCurrencyCode}, the shop currency, so it needs no exchange rate.`);
  const answer = await source.rate(shopCurrencyCode, currencyCode).catch(() => null);
  if (!answer) throw new ValidationError(`${source.label} gave no ${currencyCode} rate. Check the app's settings, or keep manual rates.`);
  return answer.rate;
}

app.openapi(createRoute({
  operationId: "dashboard.markets.delete",
  method: "delete",
  path: "/{id}",
  tags: [TAG],
  summary: "Delete a market that took no orders",
  description: "Its countries fall back to the backup market and its subfolder stops resolving. The backup market and markets with orders cannot be deleted.",
  request: {
    params: marketParam,
    query: z.object({ expectedRevision: z.coerce.number().int().positive() }),
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string() })) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  await deleteMarket(c.get("db"), id, c.req.valid("query").expectedRevision);
  return ok(c, { id });
});

/**
 * The currencies the store's active payment methods can charge: "any" when
 * one charges every currency (Stripe), else their declared currencies. Cash
 * on delivery collects any currency in its cash increment, but only for its
 * countries, so it counts only for the shop currency.
 */
async function chargeableCurrencies(c: Context<{ Bindings: Env }>, db: Parameters<typeof getActivePaymentMethods>[0]): Promise<readonly string[] | "any"> {
  const providers = await requestPaymentProviders(c as never);
  const active = await getActivePaymentMethods(db, getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>), providers);
  const codes = new Set<string>();
  for (const methodId of active.enabledMethods) {
    const gateway = providers.get(methodId);
    if (!gateway) continue;
    if (gateway.chargeCurrencies === "any") return "any";
    for (const code of gateway.chargeCurrencies) codes.add(code);
  }
  return [...codes];
}

export { app as marketsSettingsRoutes };
