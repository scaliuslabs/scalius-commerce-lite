/**
 * Line-item properties: the buyer inputs a product asks for (engraving text,
 * gift wrap, a fit choice) and what they add to the line price (Wave A §3).
 *
 * The merchant's schema lives on `products.customization_schema`. A cart
 * line carries `properties: [{ key, value }]`; the server resolves them
 * against the schema, prices the line as `base + surcharges`, and freezes a
 * labelled snapshot on `order_items.properties`. Storefront and API share
 * these functions so a cart line key and a committed line always agree.
 *
 * Properties are buyer content: never put them in URLs, analytics, logs or
 * queue payloads.
 */

export const CUSTOMIZATION_SCHEMA_VERSION = 1 as const;
export const CUSTOMIZATION_FIELD_TYPES = ["text", "textarea", "select", "checkbox"] as const;
export type CustomizationFieldType = (typeof CUSTOMIZATION_FIELD_TYPES)[number];

export const CUSTOMIZATION_LIMITS = {
  fields: 10,
  keyPattern: /^[a-z0-9_]{1,40}$/,
  labelLength: 60,
  helpLength: 200,
  textMaxLength: 200,
  textareaMaxLength: 1_000,
  selectOptions: 20,
  optionValueLength: 60,
  optionLabelLength: 60,
  /** Largest surcharge per field or option, in minor units. */
  priceMinor: 10_000_000_000,
  /** Serialized schema bound; the `products` CHECK enforces the same number. */
  serializedLength: 4_096,
} as const;

export const LINE_PROPERTY_INPUT_LIMITS = {
  entries: 10,
  valueLength: 1_000,
} as const;

/** Serialized snapshot bound; the `order_items.properties` CHECK enforces the same number. */
export const ORDER_LINE_PROPERTIES_MAX_LENGTH = 65_536;

/** Keys with this prefix carry gift-card recipient details (Wave B) and are reserved. */
export const RESERVED_PROPERTY_KEY_PREFIX = "_gc_";

export const NO_PROPERTIES_HASH = "none" as const;

interface CustomizationFieldBase {
  key: string;
  label: string;
  required: boolean;
  help: string | null;
}

export interface CustomizationTextField extends CustomizationFieldBase {
  type: "text" | "textarea";
  maxLength: number;
  /** Added once when the buyer fills the field. */
  priceMinor: number;
}

export interface CustomizationCheckboxField extends CustomizationFieldBase {
  type: "checkbox";
  /** Added when the buyer ticks the box. A required checkbox must be ticked. */
  priceMinor: number;
}

export interface CustomizationSelectOption {
  value: string;
  label: string;
  priceMinor: number;
}

export interface CustomizationSelectField extends CustomizationFieldBase {
  type: "select";
  options: CustomizationSelectOption[];
}

export type CustomizationField =
  | CustomizationTextField
  | CustomizationCheckboxField
  | CustomizationSelectField;

export interface CustomizationSchema {
  version: typeof CUSTOMIZATION_SCHEMA_VERSION;
  fields: CustomizationField[];
}

export interface CustomizationSchemaOptions {
  /** Surcharges must be multiples of this (100 for whole-taka BDT stores). */
  priceStepMinor?: number;
  /** Gift-card products may use the reserved `_gc_` keys (Wave B). */
  allowReservedKeys?: boolean;
}

export type CustomizationSchemaResult =
  | { ok: true; schema: CustomizationSchema | null }
  | { ok: false; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

/** NFC, trimmed. The one text normalization for schema text and buyer values. */
export function normalizePropertyText(value: string): string {
  return value.normalize("NFC").trim();
}

// C0/C1 controls other than tab, line feed and carriage return.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}
const LINE_BREAKS = /[\r\n]/;

function readText(
  issues: string[],
  path: string,
  value: unknown,
  maxLength: number,
  { optional }: { optional: boolean },
): string | null {
  if (value === undefined || value === null) {
    if (!optional) issues.push(`${path} is required`);
    return null;
  }
  if (typeof value !== "string") {
    issues.push(`${path} must be text`);
    return null;
  }
  const text = normalizePropertyText(value);
  if (!text) {
    if (!optional) issues.push(`${path} is required`);
    return null;
  }
  if (characterLength(text) > maxLength) issues.push(`${path} must be at most ${maxLength} characters`);
  if (hasControlCharacter(text) || LINE_BREAKS.test(text)) issues.push(`${path} must be one line of text`);
  return text;
}

function readPrice(
  issues: string[],
  path: string,
  value: unknown,
  options: CustomizationSchemaOptions,
): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > CUSTOMIZATION_LIMITS.priceMinor
  ) {
    issues.push(`${path} must be a whole number of minor units from 0`);
    return 0;
  }
  const step = options.priceStepMinor ?? 1;
  if (step > 1 && value % step !== 0) issues.push(`${path} must be a multiple of ${step}`);
  return value;
}

function readMaxLength(issues: string[], path: string, value: unknown, limit: number): number {
  if (value === undefined || value === null) return limit;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > limit) {
    issues.push(`${path} must be a whole number from 1 to ${limit}`);
    return limit;
  }
  return value;
}

function readField(
  issues: string[],
  index: number,
  raw: unknown,
  options: CustomizationSchemaOptions,
): CustomizationField | null {
  const path = `fields[${index}]`;
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  const key = typeof raw.key === "string" ? raw.key : "";
  if (!CUSTOMIZATION_LIMITS.keyPattern.test(key)) {
    issues.push(`${path}.key must be 1-40 lowercase letters, digits or underscores`);
  } else if (key.startsWith(RESERVED_PROPERTY_KEY_PREFIX) && !options.allowReservedKeys) {
    issues.push(`${path}.key uses the reserved ${RESERVED_PROPERTY_KEY_PREFIX} prefix`);
  }
  const label = readText(issues, `${path}.label`, raw.label, CUSTOMIZATION_LIMITS.labelLength, { optional: false }) ?? "";
  const help = readText(issues, `${path}.help`, raw.help, CUSTOMIZATION_LIMITS.helpLength, { optional: true });
  if (raw.required !== undefined && typeof raw.required !== "boolean") {
    issues.push(`${path}.required must be true or false`);
  }
  const base = { key, label, required: raw.required === true, help };

  switch (raw.type) {
    case "text":
    case "textarea": {
      const limit = raw.type === "text"
        ? CUSTOMIZATION_LIMITS.textMaxLength
        : CUSTOMIZATION_LIMITS.textareaMaxLength;
      if (raw.options !== undefined) issues.push(`${path}.options are only for select fields`);
      return {
        ...base,
        type: raw.type,
        maxLength: readMaxLength(issues, `${path}.maxLength`, raw.maxLength, limit),
        priceMinor: readPrice(issues, `${path}.priceMinor`, raw.priceMinor, options),
      };
    }
    case "checkbox":
      if (raw.options !== undefined) issues.push(`${path}.options are only for select fields`);
      if (raw.maxLength !== undefined) issues.push(`${path}.maxLength is only for text fields`);
      return {
        ...base,
        type: "checkbox",
        priceMinor: readPrice(issues, `${path}.priceMinor`, raw.priceMinor, options),
      };
    case "select": {
      if (raw.priceMinor !== undefined) issues.push(`${path}.priceMinor belongs on each option`);
      if (raw.maxLength !== undefined) issues.push(`${path}.maxLength is only for text fields`);
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        issues.push(`${path}.options must list at least one choice`);
        return { ...base, type: "select", options: [] };
      }
      if (raw.options.length > CUSTOMIZATION_LIMITS.selectOptions) {
        issues.push(`${path}.options must have at most ${CUSTOMIZATION_LIMITS.selectOptions} choices`);
      }
      const seen = new Set<string>();
      const choices = raw.options.map((option, optionIndex): CustomizationSelectOption => {
        const optionPath = `${path}.options[${optionIndex}]`;
        if (!isRecord(option)) {
          issues.push(`${optionPath} must be an object`);
          return { value: "", label: "", priceMinor: 0 };
        }
        const value = readText(
          issues,
          `${optionPath}.value`,
          option.value,
          CUSTOMIZATION_LIMITS.optionValueLength,
          { optional: false },
        ) ?? "";
        if (value && seen.has(value)) issues.push(`${optionPath}.value repeats another choice`);
        seen.add(value);
        return {
          value,
          label: readText(
            issues,
            `${optionPath}.label`,
            option.label,
            CUSTOMIZATION_LIMITS.optionLabelLength,
            { optional: false },
          ) ?? "",
          priceMinor: readPrice(issues, `${optionPath}.priceMinor`, option.priceMinor, options),
        };
      });
      return { ...base, type: "select", options: choices };
    }
    default:
      issues.push(`${path}.type must be one of ${CUSTOMIZATION_FIELD_TYPES.join(", ")}`);
      return null;
  }
}

/**
 * Validate and normalize a merchant schema. `null`, `undefined` and a schema
 * without fields all mean "no buyer inputs" (`schema: null`).
 */
export function parseCustomizationSchema(
  input: unknown,
  options: CustomizationSchemaOptions = {},
): CustomizationSchemaResult {
  if (input === null || input === undefined) return { ok: true, schema: null };
  if (!isRecord(input)) return { ok: false, issues: ["customization schema must be an object"] };
  const issues: string[] = [];
  if (input.version !== CUSTOMIZATION_SCHEMA_VERSION) {
    issues.push(`version must be ${CUSTOMIZATION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.fields)) {
    return { ok: false, issues: [...issues, "fields must be a list"] };
  }
  if (input.fields.length > CUSTOMIZATION_LIMITS.fields) {
    issues.push(`fields must have at most ${CUSTOMIZATION_LIMITS.fields} entries`);
  }
  const fields = input.fields
    .map((field, index) => readField(issues, index, field, options))
    .filter((field): field is CustomizationField => field !== null);
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) issues.push(`field key ${field.key} is used twice`);
    keys.add(field.key);
  }
  if (issues.length > 0) return { ok: false, issues };
  if (fields.length === 0) return { ok: true, schema: null };
  const schema: CustomizationSchema = { version: CUSTOMIZATION_SCHEMA_VERSION, fields };
  if (serializeCustomizationSchema(schema).length > CUSTOMIZATION_LIMITS.serializedLength) {
    return {
      ok: false,
      issues: [`customization schema must serialize to at most ${CUSTOMIZATION_LIMITS.serializedLength} characters`],
    };
  }
  return { ok: true, schema };
}

/** Read the stored column. A malformed value is a product error, never "no inputs". */
export function parseStoredCustomizationSchema(
  stored: string | null | undefined,
  options: CustomizationSchemaOptions = {},
): CustomizationSchemaResult {
  if (stored === null || stored === undefined) return { ok: true, schema: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { ok: false, issues: ["customization schema is not valid JSON"] };
  }
  // A stored gift-card schema may carry reserved keys; the write path decided.
  return parseCustomizationSchema(parsed, { ...options, allowReservedKeys: true });
}

export function serializeCustomizationSchema(schema: CustomizationSchema): string {
  return JSON.stringify(schema);
}

/** Whether the buyer must fill something before the line can be bought. */
export function hasRequiredCustomization(schema: CustomizationSchema | null): boolean {
  return schema?.fields.some((field) => field.required) ?? false;
}

// ---------------------------------------------------------------------------
// Buyer values
// ---------------------------------------------------------------------------

export interface LinePropertyInput {
  key: string;
  value: string;
}

/** The identity form of a line's properties: schema keys, schema order, no empties. */
export interface CanonicalLineProperty {
  key: string;
  value: string;
}

/** The frozen `order_items.properties` entry. */
export interface ResolvedLineProperty {
  key: string;
  type: CustomizationFieldType;
  label: string;
  value: string;
  /** What to print after the label: the option label for selects, "Yes" for ticked boxes. */
  displayValue: string;
  priceMinor: number;
}

export const LINE_PROPERTY_ISSUE_CODES = ["PROPERTIES_REQUIRED", "PROPERTIES_INVALID"] as const;
export type LinePropertyIssueCode = (typeof LINE_PROPERTY_ISSUE_CODES)[number];

export type ResolveLinePropertiesResult =
  | {
      ok: true;
      canonical: CanonicalLineProperty[];
      properties: ResolvedLineProperty[];
      /** Sum of the surcharges; the line's unit price is base + this. */
      propertiesPriceMinor: number;
    }
  | { ok: false; code: LinePropertyIssueCode; key: string | null; reason: string };

const CHECKBOX_TICKED = "true";
const CHECKBOX_DISPLAY = "Yes";

function inputEntries(input: unknown): unknown[] {
  if (input === undefined || input === null) return [];
  return Array.isArray(input) ? input : [input];
}

function fieldValue(field: CustomizationField, raw: string): string | null {
  const value = normalizePropertyText(raw);
  if (!value) return null;
  if (field.type === "checkbox") return value === CHECKBOX_TICKED ? value : null;
  return value;
}

/**
 * The canonical properties used for the cart line key (P2): only schema keys,
 * NFC-normalized and trimmed, empty optional fields dropped, in schema order.
 * Lenient on purpose; `resolveLineProperties` is the strict check.
 */
export function canonicalizeLineProperties(
  schema: CustomizationSchema | null,
  input: unknown,
): CanonicalLineProperty[] {
  if (!schema) return [];
  const byKey = new Map<string, string>();
  for (const entry of inputEntries(input)) {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") continue;
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry.value);
  }
  const canonical: CanonicalLineProperty[] = [];
  for (const field of schema.fields) {
    const raw = byKey.get(field.key);
    if (raw === undefined) continue;
    const value = fieldValue(field, raw);
    if (value !== null) canonical.push({ key: field.key, value });
  }
  return canonical;
}

function invalid(key: string | null, reason: string): ResolveLinePropertiesResult {
  return { ok: false, code: "PROPERTIES_INVALID", key, reason };
}

/**
 * Validate a line's properties against the product schema and price them
 * (§3.3). Runs in cart validation and again in the commit, against the
 * authority read's product row.
 */
export function resolveLineProperties(
  schema: CustomizationSchema | null,
  input: unknown,
): ResolveLinePropertiesResult {
  if (input !== undefined && input !== null && !Array.isArray(input)) {
    return invalid(null, "properties must be a list");
  }
  const entries = inputEntries(input);
  if (entries.length > LINE_PROPERTY_INPUT_LIMITS.entries) {
    return invalid(null, `at most ${LINE_PROPERTY_INPUT_LIMITS.entries} properties`);
  }
  const fields = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
  const values = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
      return invalid(null, "each property is a text key and a text value");
    }
    const field = fields.get(entry.key);
    if (!field) return invalid(entry.key, "unknown property");
    if (values.has(entry.key)) return invalid(entry.key, "property sent twice");
    if (characterLength(entry.value) > LINE_PROPERTY_INPUT_LIMITS.valueLength) {
      return invalid(entry.key, `at most ${LINE_PROPERTY_INPUT_LIMITS.valueLength} characters`);
    }
    const value = normalizePropertyText(entry.value);
    if (!value) continue;
    switch (field.type) {
      case "text":
      case "textarea":
        if (characterLength(value) > field.maxLength) {
          return invalid(entry.key, `at most ${field.maxLength} characters`);
        }
        if (hasControlCharacter(value) || (field.type === "text" && LINE_BREAKS.test(value))) {
          return invalid(entry.key, "contains characters that are not allowed");
        }
        break;
      case "checkbox":
        if (value !== CHECKBOX_TICKED) return invalid(entry.key, "a ticked box sends \"true\"");
        break;
      case "select":
        if (!field.options.some((option) => option.value === value)) {
          return invalid(entry.key, "not one of the choices");
        }
        break;
    }
    values.set(entry.key, value);
  }

  const canonical: CanonicalLineProperty[] = [];
  const properties: ResolvedLineProperty[] = [];
  let propertiesPriceMinor = 0;
  for (const field of schema?.fields ?? []) {
    const value = values.get(field.key);
    if (value === undefined) {
      if (field.required) {
        return { ok: false, code: "PROPERTIES_REQUIRED", key: field.key, reason: "required" };
      }
      continue;
    }
    const option = field.type === "select"
      ? field.options.find((choice) => choice.value === value)!
      : null;
    const priceMinor = option ? option.priceMinor : (field as CustomizationTextField | CustomizationCheckboxField).priceMinor;
    const displayValue = option ? option.label : field.type === "checkbox" ? CHECKBOX_DISPLAY : value;
    canonical.push({ key: field.key, value });
    properties.push({ key: field.key, type: field.type, label: field.label, value, displayValue, priceMinor });
    propertiesPriceMinor += priceMinor;
  }
  return { ok: true, canonical, properties, propertiesPriceMinor };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `sha256(canonical JSON)`, first 16 hex characters, or "none" without
 * properties. Identical canonical properties always hash the same.
 */
export async function linePropertiesHash(canonical: readonly CanonicalLineProperty[]): Promise<string> {
  if (canonical.length === 0) return NO_PROPERTIES_HASH;
  const payload = JSON.stringify(canonical.map((property) => [property.key, property.value]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return hex(digest).slice(0, 16);
}

/** `line:v3:<product>:variant:<variant>:p:<propertiesHash>` — same SKU + same properties = one line. */
export function lineCartKey(productId: string, variantId: string, propertiesHash: string): string {
  return `line:v3:${productId}:variant:${variantId}:p:${propertiesHash}`;
}

/** The `order_items.properties` column value: null without properties. */
export function serializeOrderLineProperties(properties: readonly ResolvedLineProperty[]): string | null {
  if (properties.length === 0) return null;
  const serialized = JSON.stringify(properties);
  if (serialized.length > ORDER_LINE_PROPERTIES_MAX_LENGTH) {
    throw new Error("Order line properties exceed the stored snapshot bound.");
  }
  return serialized;
}
