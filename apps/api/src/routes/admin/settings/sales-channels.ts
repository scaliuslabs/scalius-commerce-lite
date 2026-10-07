// Settings → Sales channels (docs/MARKETS-DESIGN.md D6), mounted at
// /admin/settings/sales-channels: the built-in channels (online store, Google,
// Meta, AI agents) and every channel an app declares. A channel can be
// switched off (not the online store; an app's follows the app) and sells the
// on-hand of the locations linked to it. Linking or unlinking a location
// advances every cache dependency (trigger) and queues a catalogue projection
// rebuild: the online store's stored availability bands read the links.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  CHANNEL_PRODUCTS_PAGE_MAX,
  getSalesChannel,
  listChannelProducts,
  listSalesChannels,
  updateSalesChannel,
} from "@scalius/core/modules/sales-channels";
import { ok } from "../../../utils/api-response";
import { enqueueCatalogProjectionRebuild } from "../../../utils/catalog-jobs";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";
import { presentSalesChannel, salesChannelRecordSchema, updateSalesChannelSchema } from "../../../schemas/sales-channels";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Sales channels";
const channelParam = z.object({ id: z.string().min(1).max(160) });
const channelEnvelope = successEnvelope(z.object({ channel: salesChannelRecordSchema }));

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

app.openapi(createRoute({
  operationId: "dashboard.sales_channels.list",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "Sales channels: where products are published",
  description: "The online store first, then Google, Meta, AI agents and each app's channels, with their status, the locations they sell from and how many products are published to each.",
  responses: {
    200: { description: "Sales channels", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(salesChannelRecordSchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { items: (await listSalesChannels(c.get("db"))).map(presentSalesChannel) });
});

app.openapi(createRoute({
  operationId: "dashboard.sales_channels.get",
  method: "get",
  path: "/{id}",
  tags: [TAG],
  summary: "One sales channel",
  request: { params: channelParam },
  responses: {
    200: { description: "The channel", content: { "application/json": { schema: channelEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { channel: presentSalesChannel(await getSalesChannel(c.get("db"), c.req.valid("param").id)) });
});

app.openapi(createRoute({
  operationId: "dashboard.sales_channels.update",
  method: "patch",
  path: "/{id}",
  tags: [TAG],
  summary: "Switch a channel on or off, or choose the locations it sells from",
  description: "A channel sells the on-hand of its linked locations, less every reservation. Every channel sells every location until you unlink one. The online store is always on; an app's channel follows the app.",
  request: {
    params: channelParam,
    body: { required: true, content: { "application/json": { schema: updateSalesChannelSchema } } },
  },
  responses: {
    200: { description: "The saved channel", content: { "application/json": { schema: channelEnvelope } } },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  noStore(c);
  const { channel, locationsChanged } = await updateSalesChannel(c.get("db"), c.req.valid("param").id, c.req.valid("json"));
  if (locationsChanged) {
    // The online store's stored availability bands read the channel's locations.
    await enqueueCatalogProjectionRebuild(c.env.JOBS_QUEUE).catch((error: unknown) => {
      console.warn("[sales-channels] projection rebuild enqueue failed", error instanceof Error ? error.name : "unknown");
    });
  }
  return ok(c, { channel: presentSalesChannel(channel) });
});

app.openapi(createRoute({
  operationId: "dashboard.sales_channels.products",
  method: "get",
  path: "/{id}/products",
  tags: [TAG],
  summary: "The products published to a channel, by id",
  description: "Keyset pages of product ids (trashed products left out): a sales-channel app syncs its listings from this and follows the `product.publication_changed` event.",
  request: {
    params: channelParam,
    query: z.object({
      after: z.string().min(1).max(64).optional().openapi({ description: "The last product id of the previous page." }),
      limit: z.coerce.number().int().min(1).max(CHANNEL_PRODUCTS_PAGE_MAX).optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of product ids",
      content: { "application/json": { schema: successEnvelope(z.object({ productIds: z.array(z.string()), nextAfter: z.string().nullable() })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const { after, limit } = c.req.valid("query");
  return ok(c, await listChannelProducts(c.get("db"), c.req.valid("param").id, { after, limit }));
});

export { app as salesChannelsSettingsRoutes };
