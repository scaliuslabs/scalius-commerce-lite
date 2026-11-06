// A plugin's id, without the manifest schema: modules that only check an id
// (custom field namespaces) stay free of zod, so dashboard pages that use them
// don't download the validation library.

/** `vendor.name`: lowercase slugs; `scalius.*` is reserved for first-party plugins. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
export const FIRST_PARTY_PLUGIN_VENDOR = "scalius";

/**
 * A key an app owns on a store resource: `<plugin id>.<key>`, a snake_case
 * key of at most 48 characters after the app id. Checkout attributes,
 * purchase options (`checkout.purchaseOptions`) and line inputs
 * (`checkout.lineInputs`) are named this way, so two apps never share one.
 */
export const APP_SCOPED_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.[a-z][a-z0-9_]{0,47}$/;
export const APP_SCOPED_KEY_MAX_LENGTH = 160;

export function appScopedKey(pluginId: string, key: string): string {
  return `${pluginId}.${key}`;
}

export function isAppScopedKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= APP_SCOPED_KEY_MAX_LENGTH && APP_SCOPED_KEY_PATTERN.test(value);
}

/** The app that owns an app-scoped key (everything before its last dot), or null for a malformed key. */
export function appScopedKeyAppId(value: string): string | null {
  if (!isAppScopedKey(value)) return null;
  return value.slice(0, value.lastIndexOf("."));
}

/** A purchase option's public id (manifest `checkout.purchaseOptions`): an app-scoped key. */
export const PURCHASE_OPTION_ID_PATTERN = APP_SCOPED_KEY_PATTERN;
export const PURCHASE_OPTION_ID_MAX_LENGTH = APP_SCOPED_KEY_MAX_LENGTH;
export const purchaseOptionId = appScopedKey;
export const isPurchaseOptionId = isAppScopedKey;
/** The app that owns a purchase option id, or null for a malformed id. */
export const purchaseOptionAppId = appScopedKeyAppId;
