// A plugin's id, without the manifest schema: modules that only check an id
// (custom field namespaces) stay free of zod, so dashboard pages that use them
// don't download the validation library.

/** `vendor.name`: lowercase slugs; `scalius.*` is reserved for first-party plugins. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
export const FIRST_PARTY_PLUGIN_VENDOR = "scalius";

/**
 * A purchase option's public id (manifest `checkout.purchaseOptions`):
 * `<plugin id>.<key>`, the checkout-attribute shape (a snake_case key of at
 * most 48 characters after the app id).
 */
export const PURCHASE_OPTION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.[a-z][a-z0-9_]{0,47}$/;
export const PURCHASE_OPTION_ID_MAX_LENGTH = 160;

export function purchaseOptionId(pluginId: string, key: string): string {
  return `${pluginId}.${key}`;
}

export function isPurchaseOptionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= PURCHASE_OPTION_ID_MAX_LENGTH && PURCHASE_OPTION_ID_PATTERN.test(value);
}

/** The app that owns a purchase option id (everything before its last dot), or null for a malformed id. */
export function purchaseOptionAppId(id: string): string | null {
  if (!isPurchaseOptionId(id)) return null;
  return id.slice(0, id.lastIndexOf("."));
}
