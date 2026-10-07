// Settings → Markets (docs/MARKETS-DESIGN.md D4), mounted at
// /admin/settings/markets. A market is its row, countries and presences under
// one revision; the database keeps one backup market, one market per country
// and the root URL for the backup alone. Triggers advance the market cache
// keys and the checkout authority fence in the write transaction. A change of
// the backup market's price increment queues a catalogue projection rebuild,
// because card prices round to it.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createMarket, deleteMarket, getMarket, listMarkets, readStoreCurrency, updateMarket } from "@scalius/core/modules/markets";
import { created, ok } from "../../../utils/api-response";
import { enqueueCatalogProjectionRebuild } from "../../../utils/catalog-jobs";
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
  description: "Each market with its status, countries, currency and web presence. Every market sells in the shop currency until markets get their own currency.",
  responses: {
    200: { description: "Markets", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(marketRecordSchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { items: (await listMarkets(c.get("db"))).map(presentMarket) });
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
  description: "Fields left out keep their value. The backup market stays active at the root URL and alone has a price increment; every other market uses it. Other markets may price by FX: product prices adjusted by a percentage, rounded up to a step and ending in an amount (MARKETS-DESIGN D5).",
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
  const { priceMode, fxRate, priceAdjustmentPercent, priceRounding, priceEnding, ...body } = c.req.valid("json");
  const db = c.get("db");
  // Pricing amounts arrive in major units of the shop currency (every market sells it until step 6).
  const currencyCode = priceRounding !== undefined || priceEnding !== undefined ? (await readStoreCurrency(db)).code : "BDT";
  const pricing = marketPricingInput({ priceMode, fxRate, priceAdjustmentPercent, priceRounding, priceEnding }, currencyCode);
  const { market, priceIncrementChanged } = await updateMarket(db, c.req.valid("param").id, { ...body, ...pricing });
  if (priceIncrementChanged) {
    // Card prices in the catalogue projections round to the increment.
    await enqueueCatalogProjectionRebuild(c.env.JOBS_QUEUE).catch((error: unknown) => {
      console.warn("[markets] projection rebuild enqueue failed", error instanceof Error ? error.name : "unknown");
    });
  }
  return ok(c, { market: presentMarket(market) });
});

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

export { app as marketsSettingsRoutes };
