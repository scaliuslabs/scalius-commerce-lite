// A custom field's identity checks without its codec: theme sections and
// blocks that bind `custom.<key>` only check a namespace and key, so the
// pages that load them (the theme editor) don't download the value codec.
// `custom-fields.ts` re-exports these; import from there everywhere else.

import { PLUGIN_ID_PATTERN } from "./plugins/ids";

/** The merchant's own namespace; a plugin writes under its plugin id (`vendor.name`). */
export const CUSTOM_FIELD_MERCHANT_NAMESPACE = "custom";
export const CUSTOM_FIELD_KEY_MAX_LENGTH = 64;
/** snake_case starting with a letter, so `custom.care_guide` binds in templates. */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** `custom` (the merchant) or a plugin id (`PLUGIN_ID_PATTERN`, e.g. `acme.loyalty`). */
export function isCustomFieldNamespace(value: unknown): value is string {
  return value === CUSTOM_FIELD_MERCHANT_NAMESPACE || (typeof value === "string" && PLUGIN_ID_PATTERN.test(value));
}

export function isCustomFieldKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= CUSTOM_FIELD_KEY_MAX_LENGTH
    && CUSTOM_FIELD_KEY_PATTERN.test(value);
}
