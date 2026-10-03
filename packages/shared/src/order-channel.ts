// Where an order came from (COMMERCE-HOOKS H2). Pure: the database CHECK, the
// order writers, the admin API, CSV export, agent operations and the
// dashboard share this vocabulary.
//
// `channel` is the surface that created the order and is set once by the
// creating path: the storefront checkout (`online_store`), a staff member in
// the dashboard (`admin`), a buyer agent's checkout (`agent`), and later the
// point of sale (`pos`) and external apps or plugins (`app`).
//
// `channelSource` narrows it with a merchant label, stored as a lowercase
// slug of at most 64 characters: where a dashboard order came in (facebook,
// whatsapp, walk_in, …), or a plugin/app id for `app` orders.

export const ORDER_CHANNELS = ["online_store", "admin", "pos", "agent", "app"] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const ORDER_CHANNEL_SOURCE_MAX_LENGTH = 64;
/** The stored shape: lowercase ASCII words joined by single `_`. */
export const ORDER_CHANNEL_SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * The sources the dashboard offers for a staff-created order: the common
 * Bangladesh order channels. Anything else is typed as free text and
 * normalized with `normalizeOrderChannelSource` (order-channel-source.ts).
 */
export const ORDER_CHANNEL_SOURCE_PRESETS = [
  "facebook",
  "instagram",
  "whatsapp",
  "phone",
  "walk_in",
] as const;
export type OrderChannelSourcePreset = (typeof ORDER_CHANNEL_SOURCE_PRESETS)[number];

export function isOrderChannel(value: unknown): value is OrderChannel {
  return typeof value === "string" && (ORDER_CHANNELS as readonly string[]).includes(value);
}

export function isOrderChannelSourcePreset(value: unknown): value is OrderChannelSourcePreset {
  return typeof value === "string" && (ORDER_CHANNEL_SOURCE_PRESETS as readonly string[]).includes(value);
}

/** True when a stored value is already a normalized source slug. */
export function isNormalizedOrderChannelSource(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= ORDER_CHANNEL_SOURCE_MAX_LENGTH
    && ORDER_CHANNEL_SOURCE_PATTERN.test(value);
}
