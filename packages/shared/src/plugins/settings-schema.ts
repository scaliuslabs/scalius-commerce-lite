// Plugin settings (docs/platform/PLUGINS.md): the merchant-facing settings a
// plugin declares in its manifest. The dashboard renders the form from this
// schema (no plugin JavaScript), the API validates every write with it, and
// `secret` values are encrypted at rest and decrypted only inside the plugin
// bridge. Part of the versioned plugin API.

import { z } from "zod";

export const PLUGIN_SETTING_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "multiselect",
  "secret",
  "url",
  "email",
  "color",
] as const;
export type PluginSettingType = (typeof PLUGIN_SETTING_TYPES)[number];

/** A setting key: lowercase words joined by underscores, unique per plugin. */
export const PLUGIN_SETTING_KEY = /^[a-z][a-z0-9_]{0,47}$/;

const label = z.string().trim().min(1).max(80);
const help = z.string().trim().min(1).max(280).optional();
const choice = z.object({ value: z.string().min(1).max(64), label }).strict();

/**
 * A settings group or provider id (`manifest.settingsGroups[].id`,
 * `manifest.providers.*[].id`): the same lowercase name both use.
 */
export const PLUGIN_SETTING_GROUP = /^[a-z][a-z0-9-]{0,47}$/;

const base = {
  key: z.string().regex(PLUGIN_SETTING_KEY),
  label,
  help,
  required: z.boolean().default(false),
  /**
   * Where the dashboard shows the field: one of the manifest's
   * `settingsGroups` (an app-wide section), or one of its provider ids (the
   * field is that provider's, shown with it where the merchant sets the
   * provider up). Left out: the app's general settings, or the provider whose
   * `settings` names it. Presentation only; storage and validation ignore it.
   */
  group: z.string().regex(PLUGIN_SETTING_GROUP).optional(),
};

export const pluginSettingFieldSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), default: z.string().max(500).optional(), maxLength: z.number().int().min(1).max(500).default(200) }).strict(),
  z.object({ ...base, type: z.literal("textarea"), default: z.string().max(5000).optional(), maxLength: z.number().int().min(1).max(5000).default(2000) }).strict(),
  z.object({
    ...base,
    type: z.literal("number"),
    default: z.number().finite().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    integer: z.boolean().default(false),
  }).strict(),
  z.object({ ...base, type: z.literal("boolean"), default: z.boolean().default(false) }).strict(),
  z.object({ ...base, type: z.literal("select"), options: z.array(choice).min(1).max(50), default: z.string().optional() }).strict(),
  z.object({ ...base, type: z.literal("multiselect"), options: z.array(choice).min(1).max(50), default: z.array(z.string()).optional() }).strict(),
  // Never echoed back: reads report only whether a value is set.
  z.object({ ...base, type: z.literal("secret") }).strict(),
  z.object({ ...base, type: z.literal("url"), default: z.string().url().optional() }).strict(),
  z.object({ ...base, type: z.literal("email"), default: z.string().email().optional() }).strict(),
  z.object({ ...base, type: z.literal("color"), default: z.string().regex(/^#[0-9a-f]{6}$/).optional() }).strict(),
]);
export type PluginSettingField = z.infer<typeof pluginSettingFieldSchema>;

export const pluginSettingsSchemaSchema = z
  .array(pluginSettingFieldSchema)
  .max(40)
  .superRefine((fields, context) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.key)) context.addIssue({ code: "custom", path: [index, "key"], message: `Duplicate setting key ${field.key}.` });
      seen.add(field.key);
      if ((field.type === "select" || field.type === "multiselect") && field.default !== undefined) {
        const values = new Set(field.options.map((option) => option.value));
        const defaults = Array.isArray(field.default) ? field.default : [field.default];
        if (!defaults.every((value) => values.has(value))) {
          context.addIssue({ code: "custom", path: [index, "default"], message: "The default must be one of the options." });
        }
      }
      if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        context.addIssue({ code: "custom", path: [index, "min"], message: "min must not exceed max." });
      }
    });
  });
export type PluginSettingsSchema = z.infer<typeof pluginSettingsSchemaSchema>;

export type PluginSettingValue = string | number | boolean | string[] | null;
export type PluginSettingValues = Record<string, PluginSettingValue>;

/** The zod schema of one field's value (null clears an optional field). */
function valueSchema(field: PluginSettingField): z.ZodType<PluginSettingValue> {
  switch (field.type) {
    case "text":
    case "textarea":
      return z.string().max(field.maxLength);
    case "secret":
      return z.string().min(1).max(4096);
    case "number": {
      let number = z.number().finite();
      if (field.integer) number = number.int();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      return number;
    }
    case "boolean":
      return z.boolean();
    case "select":
      return z.enum(field.options.map((option) => option.value) as [string, ...string[]]);
    case "multiselect":
      return z.array(z.enum(field.options.map((option) => option.value) as [string, ...string[]])).max(field.options.length);
    case "url":
      return z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Use an https:// address.");
    case "email":
      return z.string().email().max(254);
    case "color":
      return z.string().regex(/^#[0-9a-f]{6}$/);
  }
}

/**
 * Validates a settings write against the schema: unknown keys are rejected,
 * required fields must end up set (an omitted secret keeps its stored value,
 * which `secretsSet` reports), and `null` clears an optional field.
 */
export function validatePluginSettingValues(
  schema: PluginSettingsSchema,
  values: Record<string, unknown>,
  secretsSet: ReadonlySet<string> = new Set(),
): { ok: true; values: PluginSettingValues } | { ok: false; errors: Array<{ key: string; message: string }> } {
  const errors: Array<{ key: string; message: string }> = [];
  const byKey = new Map(schema.map((field) => [field.key, field]));
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) errors.push({ key, message: "Unknown setting." });
  }
  const result: PluginSettingValues = {};
  for (const field of schema) {
    const raw = values[field.key];
    if (raw === undefined || raw === null || raw === "") {
      const keptSecret = field.type === "secret" && raw === undefined && secretsSet.has(field.key);
      if (field.required && !keptSecret) errors.push({ key: field.key, message: "Required." });
      if (raw === null || raw === "") result[field.key] = null;
      continue;
    }
    const parsed = valueSchema(field).safeParse(raw);
    if (parsed.success) result[field.key] = parsed.data;
    else errors.push({ key: field.key, message: parsed.error.issues[0]?.message ?? "Invalid value." });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: result };
}

/**
 * Stored values read against the schema as it is now (the app may have been
 * updated since they were saved): every valid value is kept, an unknown key
 * is dropped, a value never set or no longer valid falls back to the field's
 * default, `null` stays cleared (absent) and an empty text stays empty.
 * Never fails; secrets are never resolved.
 */
export function resolvePluginSettingValues(schema: PluginSettingsSchema, stored: unknown): PluginSettingValues {
  const values = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const result: PluginSettingValues = {};
  for (const field of schema) {
    if (field.type === "secret") continue;
    const fallback = "default" in field && field.default !== undefined ? field.default : undefined;
    if (!Object.prototype.hasOwnProperty.call(values, field.key) || values[field.key] === undefined) {
      if (fallback !== undefined) result[field.key] = fallback;
      continue;
    }
    const raw = values[field.key];
    if (raw === null) continue;
    if (raw === "" && (field.type === "text" || field.type === "textarea")) {
      result[field.key] = "";
      continue;
    }
    const parsed = valueSchema(field).safeParse(raw);
    if (parsed.success) result[field.key] = parsed.data;
    else if (fallback !== undefined) result[field.key] = fallback;
  }
  return result;
}

/** Defaults for a fresh installation (secrets have none). */
export function pluginSettingDefaults(schema: PluginSettingsSchema): PluginSettingValues {
  const values: PluginSettingValues = {};
  for (const field of schema) {
    if (field.type !== "secret" && "default" in field && field.default !== undefined) values[field.key] = field.default;
  }
  return values;
}
