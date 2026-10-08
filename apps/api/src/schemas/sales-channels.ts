// Sales channels on the wire (docs/MARKETS-DESIGN.md D6): the dashboard's
// channel record, a channel edit, and product publications.
import { z } from "@hono/zod-openapi";
import {
  isSalesChannelId,
  PUBLICATION_BULK_MAX_CHANNELS,
  PUBLICATION_BULK_MAX_PRODUCTS,
  SALES_CHANNEL_ID_MAX_LENGTH,
  SALES_CHANNEL_KINDS,
  SALES_CHANNEL_STATUSES,
} from "@scalius/shared/sales-channels";
import type { SalesChannelRecord } from "@scalius/core/modules/sales-channels";

export const salesChannelIdSchema = z.string().max(SALES_CHANNEL_ID_MAX_LENGTH)
  .refine(isSalesChannelId, "Use a sales channel id.")
  .openapi({ description: "A sales channel id: `sc_online_store`, `sc_google`, `sc_meta`, `sc_agents`, or an app's `<plugin id>:<id>`.", example: "sc_online_store" });

export const salesChannelRecordSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string().openapi({ description: "The English name; the dashboard shows built-in channels in the staff member's language." }),
  kind: z.enum(SALES_CHANNEL_KINDS).openapi({ description: "`online_store` (the storefront), `catalog_feed` (Google, Meta), `agent` (AI agents: UCP and agent checkout), `pos`, or `app` (a sales-channel app)." }),
  pluginId: z.string().nullable().openapi({ description: "The app that declares an `app` channel." }),
  status: z.enum(SALES_CHANNEL_STATUSES).openapi({ description: "An inactive channel shows nothing: its feed is empty and its checkout refuses orders. The online store is always active; an app's channel follows the app." }),
  position: z.number().int(),
  locationIds: z.array(z.string()).openapi({ description: "The inventory locations whose on-hand the channel sells. Every channel sells every location until a merchant unlinks one." }),
  publishedProducts: z.number().int().nonnegative().openapi({ description: "Products published to it (trashed ones left out)." }),
}).openapi("SalesChannel");

export function presentSalesChannel(channel: SalesChannelRecord) {
  return { ...channel };
}

export const updateSalesChannelSchema = z.object({
  status: z.enum(SALES_CHANNEL_STATUSES).optional().openapi({ description: "Switch the channel on or off. The online store is always on; an app's channel follows the app (turn the app off in Apps)." }),
  locationIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100).optional()
    .openapi({ description: "Every location whose on-hand the channel sells: at least one active location. Its availability becomes the stock there, less every reservation." }),
}).refine((value) => value.status !== undefined || value.locationIds !== undefined, "Change the status or the locations.");

export const productPublicationsSchema = z.object({
  channelIds: z.array(salesChannelIdSchema).max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Name each sales channel once.")
    .openapi({ description: "Every channel the product is published to; the others unpublish it. An empty list takes it off every channel." }),
});

export const bulkPublicationsSchema = z.object({
  action: z.enum(["publish", "unpublish"]),
  productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(PUBLICATION_BULK_MAX_PRODUCTS),
  channelIds: z.array(salesChannelIdSchema).min(1).max(PUBLICATION_BULK_MAX_CHANNELS),
});
