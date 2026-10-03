// A plugin's id, without the manifest schema: modules that only check an id
// (custom field namespaces) stay free of zod, so dashboard pages that use them
// don't download the validation library.

/** `vendor.name`: lowercase slugs; `scalius.*` is reserved for first-party plugins. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
export const FIRST_PARTY_PLUGIN_VENDOR = "scalius";
