/**
 * Metaobjects (docs/platform/PLUGINS.md, "Metaobjects"; Shopify
 * metaobjects): content types the merchant or an app defines, and their
 * entries. A definition names its fields with the custom-field types
 * (`@scalius/shared/custom-fields`), so values are validated and stored by
 * the same codec. Published entries of a definition with storefront access
 * are public: the theme builder's Metaobjects section shows them.
 *
 * A definition is named `<namespace>.<type>` (its handle): `custom.faq` for
 * the merchant's, `acme.loyalty.tiers` for an app's. Pure and browser-safe.
 */
import { z } from "zod";
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from "./custom-fields";

export const METAOBJECT_MERCHANT_NAMESPACE = "custom";
export const METAOBJECT_DEFINITION_ID_PREFIX = "mod_";
export const METAOBJECT_ENTRY_ID_PREFIX = "moe_";

/** A type handle within its namespace: `faq`, `size_chart`. */
export const METAOBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
/** An entry handle: `shipping-faq`. */
export const METAOBJECT_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
export const METAOBJECT_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** Limits every store keeps (the same on every plan profile). */
export const METAOBJECT_DEFINITIONS_MAX = 100;
export const METAOBJECT_FIELDS_MAX = 30;
export const METAOBJECT_ENTRIES_PER_DEFINITION_MAX = 1_000;
/** The most entries one theme section shows. */
export const METAOBJECT_SECTION_ENTRIES_MAX = 24;

export const METAOBJECT_ENTRY_STATUSES = ["draft", "published"] as const;
export type MetaobjectEntryStatus = (typeof METAOBJECT_ENTRY_STATUSES)[number];

/** One field of a definition. */
export const metaobjectFieldDefinitionSchema = z.object({
  key: z.string().regex(METAOBJECT_FIELD_KEY_PATTERN, "Use lowercase letters, digits and underscores, starting with a letter."),
  name: z.string().trim().min(1).max(80),
  type: z.enum(CUSTOM_FIELD_TYPES as unknown as [CustomFieldType, ...CustomFieldType[]]),
  required: z.boolean().default(false),
  description: z.string().trim().max(300).optional(),
}).strict();
export type MetaobjectFieldDefinition = z.output<typeof metaobjectFieldDefinitionSchema>;

export const metaobjectFieldListSchema = z.array(metaobjectFieldDefinitionSchema).min(1).max(METAOBJECT_FIELDS_MAX)
  .refine((fields) => new Set(fields.map((field) => field.key)).size === fields.length, "Each field key appears once.");

/** What a definition says (the merchant's form, an app's manifest). */
export const metaobjectDefinitionInputSchema = z.object({
  type: z.string().regex(METAOBJECT_TYPE_PATTERN, "Use lowercase letters, digits and underscores, starting with a letter."),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  fields: metaobjectFieldListSchema,
  /** The field whose value names an entry (default: the first text field, else the handle). */
  displayField: z.string().regex(METAOBJECT_FIELD_KEY_PATTERN).optional(),
  /** Published entries are readable by the storefront (theme sections). */
  storefrontAccess: z.boolean().default(false),
}).strict().superRefine((definition, context) => {
  if (definition.displayField && !definition.fields.some((field) => field.key === definition.displayField)) {
    context.addIssue({ code: "custom", path: ["displayField"], message: `Field ${definition.displayField} is not defined.` });
  }
});
export type MetaobjectDefinitionInput = z.input<typeof metaobjectDefinitionInputSchema>;
export type MetaobjectDefinitionSpec = z.output<typeof metaobjectDefinitionInputSchema>;

/** A definition's handle: `<namespace>.<type>`. */
export function metaobjectHandle(namespace: string, type: string): string {
  return `${namespace}.${type}`;
}

/** The field that names entries: the declared one, else the first single-line text field. */
export function metaobjectDisplayField(fields: readonly MetaobjectFieldDefinition[], displayField: string | null | undefined): string | null {
  if (displayField && fields.some((field) => field.key === displayField)) return displayField;
  return fields.find((field) => field.type === "single_line_text")?.key ?? null;
}

/** An entry handle from a title: lowercase words joined by dashes. */
export function metaobjectHandleFrom(text: string): string {
  const handle = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/g, "");
  return handle || "entry";
}
