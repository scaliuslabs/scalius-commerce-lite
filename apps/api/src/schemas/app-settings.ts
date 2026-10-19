// An app's setting field as the dashboard draws it: the app's own settings
// (Apps -> the app) and the settings of its storefront sections and product
// blocks (the theme editor). Read from the manifest; never a value.

import { z } from "@hono/zod-openapi";
import { PLUGIN_SETTING_TYPES, type PluginSettingField, type PluginSettingItemField } from "@scalius/shared/plugins";

const appSettingItemSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export const appSettingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(appSettingItemSchema), z.null()]);

/** One field of a `list` setting's items (no lists in lists). */
export const appSettingItemFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string().nullable(),
  type: z.enum(PLUGIN_SETTING_TYPES),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  min: z.number().nullable(),
  max: z.number().nullable(),
  integer: z.boolean(),
  maxLength: z.number().int().nullable(),
}).openapi("AppSettingItemField");

export const appSettingFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string().nullable(),
  type: z.enum(PLUGIN_SETTING_TYPES),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
  default: appSettingValueSchema,
  min: z.number().nullable(),
  max: z.number().nullable(),
  integer: z.boolean(),
  maxLength: z.number().int().nullable(),
  group: z.string().optional().openapi({ description: "The settings group or provider id the field shows with (absent: the app's general settings)." }),
  limit: z.number().int().optional().openapi({ description: "`products`: how many products the setting shows." }),
  fields: z.array(appSettingItemFieldSchema).optional().openapi({ description: "`list`: the fields of each item." }),
  itemLabel: z.string().optional().openapi({ description: "`list`: what one item is called (\"Slide\")." }),
}).openapi("AppSettingField");

function appSettingItemField(field: PluginSettingItemField): z.infer<typeof appSettingItemFieldSchema> {
  const fallback = "default" in field && field.default !== undefined ? field.default : null;
  return {
    key: field.key,
    label: field.label,
    help: field.help ?? null,
    type: field.type,
    required: field.required,
    options: field.type === "select" ? field.options.map((option) => ({ value: option.value, label: option.label })) : null,
    default: fallback as string | number | boolean | null,
    min: field.type === "number" ? field.min ?? null : null,
    max: field.type === "number" ? field.max ?? null : null,
    integer: field.type === "number" ? field.integer : false,
    maxLength: field.type === "text" || field.type === "textarea" ? field.maxLength : null,
  };
}

export function appSettingField(field: PluginSettingField): z.infer<typeof appSettingFieldSchema> {
  const withOptions = field.type === "select" || field.type === "multiselect" ? field.options : null;
  const fallback = field.type !== "secret" && "default" in field && field.default !== undefined ? field.default : null;
  return {
    ...(field.type === "products" ? { limit: field.limit } : {}),
    ...(field.type === "list" ? { fields: field.fields.map(appSettingItemField), ...(field.itemLabel ? { itemLabel: field.itemLabel } : {}) } : {}),
    key: field.key,
    label: field.label,
    help: field.help ?? null,
    type: field.type,
    required: field.required,
    options: withOptions ? withOptions.map((option) => ({ value: option.value, label: option.label })) : null,
    default: fallback as z.infer<typeof appSettingValueSchema>,
    min: field.type === "number" || field.type === "list" ? field.min ?? null : null,
    max: field.type === "number" || field.type === "list" ? field.max ?? null : null,
    integer: field.type === "number" ? field.integer : false,
    maxLength: field.type === "text" || field.type === "textarea" ? field.maxLength : null,
    ...(field.group ? { group: field.group } : {}),
  };
}

/** The provider's last connection test with its current settings: "Ready" needs `passed` when it offers one. */
export const providerConnectionSchema = z.object({
  status: z.enum(["none", "untested", "passed", "failed"]).openapi({ description: "none: it offers no test; untested: not tested with its current settings." }),
  testedAt: z.string().nullable(),
  message: z.string().nullable().openapi({ description: "The provider's answer when the last test failed." }),
}).openapi("AppProviderConnection");
