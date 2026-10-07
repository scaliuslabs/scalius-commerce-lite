// An app's setting field as the dashboard draws it: the app's own settings
// (Apps -> the app) and the settings of its storefront sections and product
// blocks (the theme editor). Read from the manifest; never a value.

import { z } from "@hono/zod-openapi";
import { PLUGIN_SETTING_TYPES, type PluginSettingField } from "@scalius/shared/plugins";

export const appSettingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);

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
}).openapi("AppSettingField");

export function appSettingField(field: PluginSettingField): z.infer<typeof appSettingFieldSchema> {
  const withOptions = field.type === "select" || field.type === "multiselect" ? field.options : null;
  const fallback = field.type !== "secret" && "default" in field && field.default !== undefined ? field.default : null;
  return {
    key: field.key,
    label: field.label,
    help: field.help ?? null,
    type: field.type,
    required: field.required,
    options: withOptions ? withOptions.map((option) => ({ value: option.value, label: option.label })) : null,
    default: fallback as string | number | boolean | string[] | null,
    min: field.type === "number" ? field.min ?? null : null,
    max: field.type === "number" ? field.max ?? null : null,
    integer: field.type === "number" ? field.integer : false,
    maxLength: field.type === "text" || field.type === "textarea" ? field.maxLength : null,
    ...(field.group ? { group: field.group } : {}),
  };
}
