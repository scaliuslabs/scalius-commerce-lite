/**
 * Typed spec attributes (migration 0088): value types, facet widgets, units,
 * normalised values and the facet-projection keys.
 *
 * Storage (`product_attribute_values`), enforced by triggers:
 * - `text`: display `value` only; its facet key is the normalised text.
 * - `enum`: `value_id` names one of the attribute's `attribute_values`.
 * - `number`: `value_number` plus the display `value` (with the unit).
 * - `boolean`: `value_number` 0 or 1.
 */
import { z } from "zod";
import { normalizeProductOptionIdentity } from "./product-options";

export const ATTRIBUTE_VALUE_TYPES = ["text", "number", "boolean", "enum"] as const;
export type AttributeValueType = (typeof ATTRIBUTE_VALUE_TYPES)[number];

/** Listing filter widgets: checkboxes, a numeric range, colour swatches, a searchable list. */
export const ATTRIBUTE_FACET_DISPLAYS = ["checkbox", "range", "swatch", "search_list"] as const;
export type AttributeFacetDisplay = (typeof ATTRIBUTE_FACET_DISPLAYS)[number];

export const ATTRIBUTE_UNIT_MAX_LENGTH = 16;
export const ATTRIBUTE_VALUE_MAX_LENGTH = 200;
export const ATTRIBUTE_GROUP_NAME_MAX_LENGTH = 80;

/** `range` needs numbers and `swatch` needs enum values with colours (the database CHECK). */
export function isAttributeFacetDisplayAllowed(type: AttributeValueType, display: AttributeFacetDisplay): boolean {
  if (display === "range") return type === "number";
  if (display === "swatch") return type === "enum";
  return true;
}

export function defaultAttributeFacetDisplay(type: AttributeValueType): AttributeFacetDisplay {
  return type === "number" ? "range" : "checkbox";
}

/** The identity of a text or enum value: trimmed and lowercased, like option values. */
export function normalizeAttributeValue(value: string): string {
  return normalizeProductOptionIdentity(value);
}

export const attributeUnitSchema = z.string().trim().min(1).max(ATTRIBUTE_UNIT_MAX_LENGTH).nullable();
export const attributeSwatchHexSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/, "Use a lowercase #rrggbb colour.")
  .nullable();

export const attributeDefinitionSchema = z.object({
  valueType: z.enum(ATTRIBUTE_VALUE_TYPES),
  unit: attributeUnitSchema,
  facetDisplay: z.enum(ATTRIBUTE_FACET_DISPLAYS),
  keySpec: z.boolean(),
  highlight: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
}).strict().superRefine((definition, context) => {
  if (!isAttributeFacetDisplayAllowed(definition.valueType, definition.facetDisplay)) {
    context.addIssue({
      code: "custom",
      path: ["facetDisplay"],
      message: `A ${definition.facetDisplay} filter does not suit ${definition.valueType} values.`,
    });
  }
  if (definition.unit !== null && definition.valueType !== "number") {
    context.addIssue({ code: "custom", path: ["unit"], message: "Only number attributes have a unit." });
  }
});
export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

/**
 * The canonical text of a number value: no exponent, no trailing zeros, at
 * most 6 decimals (15.60 -> "15.6", 1e3 -> "1000"). Used as the facet value key.
 */
export function canonicalAttributeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("Attribute numbers must be finite.");
  const rounded = Math.round(value * 1e6) / 1e6;
  const text = (Object.is(rounded, -0) ? 0 : rounded).toFixed(6).replace(/\.?0+$/, "");
  return text === "" ? "0" : text;
}

/** A merchant-typed number ("15.6", "1,000", "2.4") or null when it is not one. */
export function parseAttributeNumber(input: string): number | null {
  const text = input.trim().replace(/,/g, "");
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) < 1e12 ? value : null;
}

/** The stored columns of one product attribute value. */
export type TypedAttributeValue =
  | { type: "text"; value: string; valueId: null; valueNumber: null }
  | { type: "enum"; value: string; valueId: string; valueNumber: null }
  | { type: "number"; value: string; valueId: null; valueNumber: number }
  | { type: "boolean"; value: string; valueId: null; valueNumber: 0 | 1 };

/** The facet projection key and label of a typed value (`product_facet_values`). */
export function attributeFacetValueKey(value: TypedAttributeValue): string {
  switch (value.type) {
    case "text": return normalizeAttributeValue(value.value);
    case "enum": return value.valueId;
    case "number": return canonicalAttributeNumber(value.valueNumber);
    case "boolean": return String(value.valueNumber);
  }
}

/** URL/facet key prefix for merchant option axes; matches the storefront `option.<axis>` filters. */
export const OPTION_FACET_KEY_PREFIX = "option.";

/** The facet key of a merchant option axis ("Screen size" -> "option.screen-size"). */
export function optionFacetKey(axisName: string): string {
  return `${OPTION_FACET_KEY_PREFIX}${normalizeProductOptionIdentity(axisName).replaceAll(" ", "-")}`;
}
