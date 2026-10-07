// Sales channels (docs/MARKETS-DESIGN.md D6, step 5): where products are
// published. Pure vocabulary shared by the database CHECKs, the API, the
// storefront, the dashboard and the plugin manifest.
//
// Shopify gives each surface its own channel (Online Store, Google & YouTube,
// Facebook & Instagram, Shop and the agentic catalogue, Point of Sale, and one
// per sales-channel app). Migration 0122 seeds the built-in surfaces the same
// way: the online store, the Google catalogue feed, the Meta catalogue feed and
// AI agents (the UCP catalogue and agent checkout). An app declares its own
// `app` channel in its manifest. A channel is never a stock count: its
// sellable stock is the on-hand of its linked locations.
//
// `orders.channel` (`@scalius/shared/order-channel`) stays the attribution of
// the surface that created an order; `orders.sales_channel_id` names the
// channel whose publications the order sold from.

export const SALES_CHANNEL_KINDS = ["online_store", "pos", "catalog_feed", "agent", "app"] as const;
export type SalesChannelKind = (typeof SALES_CHANNEL_KINDS)[number];

/** `inactive`: the channel shows nothing (a feed is empty, an app channel's app is off). */
export const SALES_CHANNEL_STATUSES = ["active", "inactive"] as const;
export type SalesChannelStatus = (typeof SALES_CHANNEL_STATUSES)[number];

/** The default online store: the storefront's catalogue. Always active; it cannot be removed. */
export const ONLINE_STORE_CHANNEL_ID = "sc_online_store";
/** The Google (Merchant Center) catalogue feed, `/api/product-feed.xml`. */
export const GOOGLE_CHANNEL_ID = "sc_google";
/** The Meta (Facebook and Instagram) catalogue feed, `/api/facebook-feed.xml`. */
export const META_CHANNEL_ID = "sc_meta";
/** AI agents: the UCP catalogue (`/.well-known/ucp`) and buyer-agent checkout. */
export const AGENTS_CHANNEL_ID = "sc_agents";

/** The channels migration 0122 seeds, in list order. */
export const BUILT_IN_SALES_CHANNEL_IDS = [
  ONLINE_STORE_CHANNEL_ID,
  GOOGLE_CHANNEL_ID,
  META_CHANNEL_ID,
  AGENTS_CHANNEL_ID,
] as const;
export type BuiltInSalesChannelId = (typeof BUILT_IN_SALES_CHANNEL_IDS)[number];

/** The catalogue surfaces that read `/api/v1/products/feed`, and the channel each reads. */
export const CATALOG_SURFACE_CHANNELS = {
  google: GOOGLE_CHANNEL_ID,
  meta: META_CHANNEL_ID,
  agents: AGENTS_CHANNEL_ID,
} as const satisfies Record<string, BuiltInSalesChannelId>;
export type CatalogSurface = keyof typeof CATALOG_SURFACE_CHANNELS;
export const CATALOG_SURFACES = Object.keys(CATALOG_SURFACE_CHANNELS) as CatalogSurface[];

/** The channels a catalogue read may name (`/api/v1/products/feed?channel=`). */
export const CATALOG_CHANNEL_IDS = [GOOGLE_CHANNEL_ID, META_CHANNEL_ID, AGENTS_CHANNEL_ID] as const;
export type CatalogChannelId = (typeof CATALOG_CHANNEL_IDS)[number];

export function isCatalogChannelId(value: unknown): value is CatalogChannelId {
  return typeof value === "string" && (CATALOG_CHANNEL_IDS as readonly string[]).includes(value);
}

export function isBuiltInSalesChannelId(value: unknown): value is BuiltInSalesChannelId {
  return typeof value === "string" && (BUILT_IN_SALES_CHANNEL_IDS as readonly string[]).includes(value);
}

/**
 * A channel id: a built-in `sc_<word>` or an app channel `<plugin id>:<id>`
 * (`acme.tiktok:shop`; the plugin id and manifest name shapes).
 */
export const SALES_CHANNEL_ID_PATTERN = /^(?:sc_[a-z0-9_]{1,40}|[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?:[a-z][a-z0-9-]{0,47})$/;
export const SALES_CHANNEL_ID_MAX_LENGTH = 160;

export function isSalesChannelId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= SALES_CHANNEL_ID_MAX_LENGTH
    && SALES_CHANNEL_ID_PATTERN.test(value);
}

/** The id of an app's channel: `<plugin id>:<channel id>` (the provider id shape). */
export function appSalesChannelId(pluginId: string, channelId: string): string {
  return `${pluginId}:${channelId}`;
}

/** A channel's name: 1 to 80 characters, trimmed. */
export const SALES_CHANNEL_NAME_MAX_LENGTH = 80;

/**
 * The sales channel an order sells from when its surface does not name one:
 * the storefront and staff sell the online store's catalogue, buyer agents
 * sell the agents channel's.
 */
export function defaultOrderSalesChannelId(orderChannel: string): BuiltInSalesChannelId {
  return orderChannel === "agent" ? AGENTS_CHANNEL_ID : ONLINE_STORE_CHANNEL_ID;
}

/** At most this many channels per bulk publish or unpublish, and products per call. */
export const PUBLICATION_BULK_MAX_PRODUCTS = 90;
export const PUBLICATION_BULK_MAX_CHANNELS = 10;
