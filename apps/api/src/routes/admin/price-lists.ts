// Price lists (docs/MARKETS-DESIGN.md D5), mounted at /admin/price-lists: a
// market's fixed prices, a customer segment's prices in a market, or a
// scheduled sale, with quantity breaks. A list and its prices are written
// under one revision. Triggers advance the market's pricing cache keys and
// the checkout authority fence in the write transaction; nothing is
// precomputed, so a save prices the next read.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  createPriceList,
  deletePriceList,
  getPriceList,
  listPriceLists,
  listPriceListVariants,
  priceListChoices,
  setPriceListPrices,
  updatePriceList,
} from "@scalius/core/modules/price-lists";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import {
  createPriceListSchema,
  presentPriceList,
  presentPriceListVariant,
  priceListSchema,
  priceListVariantSchema,
  scheduleInstant,
  setPriceListPricesSchema,
  updatePriceListSchema,
} from "../../schemas/price-lists";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Price lists";
const idParam = z.object({ id: z.string().min(1).max(64) });
const listEnvelope = successEnvelope(z.object({ priceList: priceListSchema }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

app.openapi(createRoute({
  operationId: "dashboard.price_lists.list",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "Price lists, by name",
  description: "Every price list (a store keeps at most 100) with its market, segment, schedule state and how many SKUs it prices. `marketId` narrows to one market.",
  request: { query: z.object({ marketId: z.string().min(1).max(64).optional() }) },
  responses: {
    200: { description: "Price lists", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(priceListSchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const { marketId } = c.req.valid("query");
  return ok(c, { items: (await listPriceLists(c.get("db"), { marketId })).map(presentPriceList) });
});

app.openapi(createRoute({
  operationId: "dashboard.price_lists.create",
  method: "post",
  path: "/",
  tags: [TAG],
  summary: "Create a price list",
  description: "A market list prices a non-backup market for every buyer; a sale list does too, between its start and end, and wins over the market list; a segment list prices the signed-in members of one customer segment in a market (the backup market included). A new list is a draft until set active.",
  request: { body: { required: true, content: { "application/json": { schema: createPriceListSchema } } } },
  responses: {
    201: { description: "The new price list", content: { "application/json": { schema: listEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { startsAt, endsAt, ...input } = c.req.valid("json");
  const priceList = await createPriceList(c.get("db"), {
    ...input,
    startsAt: scheduleInstant(startsAt) ?? null,
    endsAt: scheduleInstant(endsAt) ?? null,
  });
  return created(c, { priceList: presentPriceList(priceList) });
});

const choicesSchema = z.object({
  markets: z.array(z.object({ id: z.string(), name: z.string(), isBackup: z.boolean() })),
  segments: z.array(z.object({ id: z.string(), name: z.string() })),
}).openapi("PriceListChoices");

// Registered before /{id}: "choices" is not a list id.
app.openapi(createRoute({
  operationId: "dashboard.price_lists.choices",
  method: "get",
  path: "/choices",
  tags: [TAG],
  summary: "Markets and customer segments a price list can price",
  description: "Every market (the backup first) and every customer segment, by name: the choices for a new price list.",
  responses: {
    200: { description: "The choices", content: { "application/json": { schema: successEnvelope(choicesSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, await priceListChoices(c.get("db")));
});

app.openapi(createRoute({
  operationId: "dashboard.price_lists.get",
  method: "get",
  path: "/{id}",
  tags: [TAG],
  summary: "One price list",
  request: { params: idParam },
  responses: {
    200: { description: "The price list", content: { "application/json": { schema: listEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { priceList: presentPriceList(await getPriceList(c.get("db"), c.req.valid("param").id)) });
});

app.openapi(createRoute({
  operationId: "dashboard.price_lists.update",
  method: "patch",
  path: "/{id}",
  tags: [TAG],
  summary: "Edit a price list under the revision the editor loaded",
  description: "Fields left out keep their value. Setting `status` to `active` starts pricing (within its schedule); `draft` stops it.",
  request: {
    params: idParam,
    body: { required: true, content: { "application/json": { schema: updatePriceListSchema } } },
  },
  responses: {
    200: { description: "The saved price list", content: { "application/json": { schema: listEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { startsAt, endsAt, ...update } = c.req.valid("json");
  const priceList = await updatePriceList(c.get("db"), c.req.valid("param").id, {
    ...update,
    startsAt: scheduleInstant(startsAt),
    endsAt: scheduleInstant(endsAt),
  });
  return ok(c, { priceList: presentPriceList(priceList) });
});

app.openapi(createRoute({
  operationId: "dashboard.price_lists.delete",
  method: "delete",
  path: "/{id}",
  tags: [TAG],
  summary: "Delete a price list and its prices",
  description: "Orders keep the prices they were placed at; the list's SKUs price by the next rule (another list, FX or the product price).",
  request: {
    params: idParam,
    query: z.object({ expectedRevision: z.coerce.number().int().positive() }),
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string() })) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  await deletePriceList(c.get("db"), id, c.req.valid("query").expectedRevision);
  return ok(c, { id });
});

app.openapi(createRoute({
  operationId: "dashboard.price_lists.prices_list",
  method: "get",
  path: "/{id}/prices",
  tags: [TAG],
  summary: "One page of a price list's SKUs and their prices",
  description: "By product name then SKU. `search` matches the product name or the SKU code.",
  request: {
    params: idParam,
    query: z.object({
      page: z.coerce.number().int().min(1).max(1_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      search: z.string().trim().max(120).optional(),
    }),
  },
  responses: {
    200: {
      description: "The page",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            items: z.array(priceListVariantSchema),
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
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const [priceList, page] = await Promise.all([
    getPriceList(db, id),
    listPriceListVariants(db, id, c.req.valid("query")),
  ]);
  return ok(c, { ...page, items: page.items.map((item) => presentPriceListVariant(item, priceList.currencyCode)) });
});

app.openapi(createRoute({
  operationId: "dashboard.price_lists.prices_set",
  method: "put",
  path: "/{id}/prices",
  tags: [TAG],
  summary: "Set or remove SKU prices of a price list",
  description: "`set` replaces each named SKU's prices (its price for one unit and up to four quantity breaks); `remove` takes SKUs out. At most 100 SKUs per save, at most 5,000 prices per list. Prices are in the market's currency at its price increment.",
  request: {
    params: idParam,
    body: { required: true, content: { "application/json": { schema: setPriceListPricesSchema } } },
  },
  responses: {
    200: { description: "The saved price list", content: { "application/json": { schema: listEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const priceList = await setPriceListPrices(c.get("db"), c.req.valid("param").id, c.req.valid("json"));
  return ok(c, { priceList: presentPriceList(priceList) });
});

export { app as adminPriceListRoutes };
