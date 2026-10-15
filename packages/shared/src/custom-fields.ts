// Custom fields (COMMERCE-HOOKS H4): typed values that merchants and plugins
// attach to products, SKUs, customers, orders, categories, collections,
// brands and pages, like Shopify metafields. Pure: the database CHECKs, the
// core writers, the admin API, agents, plugins and the dashboard share this
// vocabulary and codec, so a value one of them accepts every other accepts.
//
// A definition names a field: owner type, namespace (`custom` for the
// merchant, a plugin id for a plugin), key, type and validations. A value is
// one canonical text per (definition, owner):
// - a single value is its type's canonical string ("12.5", "true",
//   "2026-10-02", "#ff0000", a JSON text, an id);
// - a list is a JSON array of item canonical strings (`["S","M"]`);
// - money is integer minor units of the store currency ("1250").
//
// The HTTP edge carries typed JSON (`customFieldWireValue`): strings for text,
// dates, URLs, colours and references; numbers for integers; a decimal
// string for decimals (no float rounding); booleans; any JSON for `json`;
// decimal major units for money (converted exactly once, here); arrays of
// those for lists. `null`, an empty string or an empty list clears a value.

import { toHandle } from "./handle";
import { fromMinor, isIncrementMultipleMinor, priceIncrementMessage, toMinor } from "./money";
import { PLUGIN_ID_PATTERN } from "./plugins/ids";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const CUSTOM_FIELD_OWNER_TYPES = [
  "product",
  "variant",
  "customer",
  "order",
  "category",
  "collection",
  "brand",
  "page",
] as const;
export type CustomFieldOwnerType = (typeof CUSTOM_FIELD_OWNER_TYPES)[number];

/** Owner types a buyer can see; customer and order fields are never public. */
export const CUSTOM_FIELD_STOREFRONT_OWNER_TYPES = [
  "product",
  "variant",
  "category",
  "collection",
  "brand",
  "page",
] as const satisfies readonly CustomFieldOwnerType[];

export function customFieldOwnerIsStorefront(ownerType: CustomFieldOwnerType): boolean {
  return (CUSTOM_FIELD_STOREFRONT_OWNER_TYPES as readonly string[]).includes(ownerType);
}

export const CUSTOM_FIELD_SCALAR_TYPES = [
  "single_line_text",
  "multi_line_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "date_time",
  "url",
  "color",
  "json",
  "money",
  "product_reference",
  "variant_reference",
  "collection_reference",
  "media_reference",
  "object_reference",
] as const;
export type CustomFieldScalarType = (typeof CUSTOM_FIELD_SCALAR_TYPES)[number];

/**
 * Scalar types with a `list.` form: all but `boolean` (a list of flags says
 * nothing a set of booleans would not) and `json` (a JSON value already holds
 * arrays).
 */
export type CustomFieldListableType = Exclude<CustomFieldScalarType, "boolean" | "json">;
export type CustomFieldListType = `list.${CustomFieldListableType}`;
export type CustomFieldType = CustomFieldScalarType | CustomFieldListType;

export const CUSTOM_FIELD_TYPES = [
  ...CUSTOM_FIELD_SCALAR_TYPES,
  "list.single_line_text",
  "list.multi_line_text",
  "list.integer",
  "list.decimal",
  "list.date",
  "list.date_time",
  "list.url",
  "list.color",
  "list.money",
  "list.product_reference",
  "list.variant_reference",
  "list.collection_reference",
  "list.media_reference",
  "list.object_reference",
] as const satisfies readonly CustomFieldType[];

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return typeof value === "string" && (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);
}

export function isCustomFieldListType(type: CustomFieldType): type is CustomFieldListType {
  return type.startsWith("list.");
}

/** The type of one item: the type itself, or the list's item type. */
export function customFieldItemType(type: CustomFieldType): CustomFieldScalarType {
  return (isCustomFieldListType(type) ? type.slice(5) : type) as CustomFieldScalarType;
}

export type CustomFieldReferenceTarget = "product" | "variant" | "collection" | "media" | "object";

/** What a reference type points at, or null for a plain value type. */
export function customFieldReferenceTarget(type: CustomFieldType): CustomFieldReferenceTarget | null {
  switch (customFieldItemType(type)) {
    case "product_reference": return "product";
    case "variant_reference": return "variant";
    case "collection_reference": return "collection";
    case "media_reference": return "media";
    case "object_reference": return "object";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Identity: namespace, key, name
// ---------------------------------------------------------------------------

/** The merchant's own namespace; a plugin writes under its plugin id (`vendor.name`). */
export const CUSTOM_FIELD_MERCHANT_NAMESPACE = "custom";
export const CUSTOM_FIELD_ID_PREFIX = "cfd_";
/** A plugin id's longest form (`PLUGIN_ID_PATTERN`: 40-character vendor, dot, 60-character name). */
export const CUSTOM_FIELD_NAMESPACE_MAX_LENGTH = 101;
export const CUSTOM_FIELD_KEY_MAX_LENGTH = 64;
/** snake_case starting with a letter, so `custom.care_guide` binds in templates. */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const CUSTOM_FIELD_NAME_MAX_LENGTH = 80;
export const CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH = 300;
/** Definitions per owner type, all namespaces together. */
export const CUSTOM_FIELD_DEFINITIONS_PER_OWNER_MAX = 100;

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

/**
 * A key from free text (usually the field's name): Bangla is transliterated,
 * accents are folded, anything else becomes a single `_` ("Care guide" →
 * `care_guide`, "১ম রং" → `f_1m_rong`). Returns null when nothing readable is
 * left.
 */
export function normalizeCustomFieldKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let key = toHandle(value).replace(/-/g, "_");
  if (/^[0-9]/.test(key)) key = `f_${key}`;
  key = key.slice(0, CUSTOM_FIELD_KEY_MAX_LENGTH).replace(/_+$/, "");
  return isCustomFieldKey(key) ? key : null;
}

/** Who writes: the merchant (dashboard, management API, agents) or a plugin. */
export type CustomFieldWriter =
  | { readonly kind: "merchant" }
  | { readonly kind: "plugin"; readonly pluginId: string };

export const MERCHANT_CUSTOM_FIELD_WRITER: CustomFieldWriter = Object.freeze({ kind: "merchant" });

/** The one namespace a writer may create definitions in and write values of. */
export function customFieldWriterNamespace(writer: CustomFieldWriter): string {
  return writer.kind === "merchant" ? CUSTOM_FIELD_MERCHANT_NAMESPACE : writer.pluginId;
}

/** The merchant (staff, agents, the management API) writes only `custom`; a plugin only its own id. */
export function canWriteCustomFieldNamespace(writer: CustomFieldWriter, namespace: string): boolean {
  if (writer.kind === "merchant") return namespace === CUSTOM_FIELD_MERCHANT_NAMESPACE;
  return PLUGIN_ID_PATTERN.test(writer.pluginId) && namespace === writer.pluginId;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const CUSTOM_FIELD_LIST_MAX_ITEMS = 128;
/** The stored text of one value, whatever its type (a database CHECK too). */
export const CUSTOM_FIELD_VALUE_MAX_LENGTH = 65_536;
export const CUSTOM_FIELD_SINGLE_LINE_MAX_LENGTH = 1_000;
export const CUSTOM_FIELD_MULTI_LINE_MAX_LENGTH = 20_000;
export const CUSTOM_FIELD_URL_MAX_LENGTH = 2_048;
export const CUSTOM_FIELD_CHOICES_MAX = 128;
export const CUSTOM_FIELD_REGEX_MAX_LENGTH = 200;
/** Record ids a reference may hold (`prod_…`, `var_…`, `col_…`, media ids). */
export const CUSTOM_FIELD_REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Decimals: at most 18 integer and 9 fraction digits, kept exact as text. */
const DECIMAL_INTEGER_DIGITS = 18;
const DECIMAL_FRACTION_DIGITS = 9;
const JSON_MAX_DEPTH = 32;

const TEXT_MAX_LENGTH: Partial<Record<CustomFieldScalarType, number>> = {
  single_line_text: CUSTOM_FIELD_SINGLE_LINE_MAX_LENGTH,
  multi_line_text: CUSTOM_FIELD_MULTI_LINE_MAX_LENGTH,
  url: CUSTOM_FIELD_URL_MAX_LENGTH,
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type CustomFieldIssueCode =
  | "invalid"
  | "too_short"
  | "too_long"
  | "too_small"
  | "too_large"
  | "pattern"
  | "not_a_choice"
  | "too_many_items"
  | "whole_amount"
  | "invalid_validation";

export interface CustomFieldIssue {
  readonly code: CustomFieldIssueCode;
  /** English, for API errors; the dashboard renders its own copy from `code` and `limit`. */
  readonly message: string;
  /** The list item the issue is about. */
  readonly index?: number;
  /** The bound that was crossed, as the wire shows it. */
  readonly limit?: string | number;
}

export type CustomFieldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issue: CustomFieldIssue };

const ok = <T>(value: T): CustomFieldResult<T> => ({ ok: true, value });
const fail = (code: CustomFieldIssueCode, message: string, extra: { index?: number; limit?: string | number } = {}): CustomFieldResult<never> =>
  ({ ok: false, issue: { code, message, ...extra } });

/** The store currency, needed only by money. */
export interface CustomFieldCodecContext {
  readonly decimalPlaces: number;
  readonly currencyCode: string;
  /**
   * Writes: the market's price increment a money value must be a multiple of
   * (`@scalius/shared/currency-policy`). Reads leave it out: a stored value
   * was valid when it was written.
   */
  readonly priceIncrementMinor?: number;
}

export type CustomFieldJson =
  | null
  | boolean
  | number
  | string
  | CustomFieldJson[]
  | { [key: string]: CustomFieldJson };

/** A value as the HTTP contract carries it. */
export type CustomFieldWireValue = CustomFieldJson;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** A canonical decimal ("-0012.50" → "-12.5"), or null. */
function canonicalDecimal(input: unknown): string | null {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    text = String(input);
    if (/e/i.test(text)) return null;
  } else if (typeof input === "string") {
    text = input.trim();
  } else {
    return null;
  }
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return null;
  const integer = match[2]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (integer.length > DECIMAL_INTEGER_DIGITS || fraction.length > DECIMAL_FRACTION_DIGITS) return null;
  const magnitude = fraction ? `${integer}.${fraction}` : integer;
  return match[1] === "-" && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

/** Exact comparison of two canonical decimals. */
function compareDecimal(left: string, right: string): number {
  const scaled = (value: string) => {
    const negative = value.startsWith("-");
    const [integer, fraction = ""] = (negative ? value.slice(1) : value).split(".");
    const magnitude = BigInt(`${integer}${fraction.padEnd(DECIMAL_FRACTION_DIGITS, "0")}`);
    return negative ? -magnitude : magnitude;
  };
  const difference = scaled(left) - scaled(right);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function canonicalInteger(input: unknown): string | null {
  if (typeof input === "number") return Number.isSafeInteger(input) ? String(input === 0 ? 0 : input) : null;
  if (typeof input !== "string" || !/^[+-]?\d{1,16}$/.test(input.trim())) return null;
  const value = Number(input.trim());
  return Number.isSafeInteger(value) ? String(value === 0 ? 0 : value) : null;
}

function canonicalDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return match[0];
}

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An instant with an explicit offset, stored in UTC ("2026-10-02T04:00:00Z"). */
function canonicalDateTime(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!DATE_TIME_PATTERN.test(text) || canonicalDate(text.slice(0, 10)) === null) return null;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

const URL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** An absolute http(s)/mailto/tel URL, or a same-store path (`/pages/size-guide`). */
function canonicalUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  // No whitespace, controls or backslashes anywhere (they change how browsers parse).
  if (!text || /[\s\\]/.test(text) || hasControlCharacter(text)) return null;
  if (text.startsWith("/")) return text.startsWith("//") ? null : text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!URL_SCHEMES.has(url.protocol)) return null;
  if ((url.protocol === "http:" || url.protocol === "https:") && (!url.hostname || url.username || url.password)) return null;
  return url.href;
}

function canonicalColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  const hex = match[1]!.toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex}`;
}

/** Whether the text holds a C0 control character or DEL (optionally allowing tab and line feed). */
function hasControlCharacter(text: string, options: { allowTabAndLineFeed?: boolean } = {}): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code < 0x20 && !(options.allowTabAndLineFeed && (code === 0x09 || code === 0x0a))) return true;
  }
  return false;
}

function isJsonValue(value: unknown, depth = 0): value is CustomFieldJson {
  if (depth > JSON_MAX_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
  }
  return false;
}

function canonicalBoolean(input: unknown): string | null {
  if (input === true || input === "true") return "true";
  if (input === false || input === "false") return "false";
  return null;
}

function canonicalText(input: unknown, multiLine: boolean): string | null {
  if (typeof input !== "string") return null;
  const text = (multiLine ? input.replace(/\r\n?/g, "\n") : input).trim();
  if (!multiLine && /[\r\n]/.test(text)) return null;
  // Controls other than tab and line feed never belong in merchant text.
  if (hasControlCharacter(text, { allowTabAndLineFeed: true })) return null;
  return text;
}

function canonicalReference(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const id = input.trim();
  return CUSTOM_FIELD_REFERENCE_ID_PATTERN.test(id) ? id : null;
}

const TYPE_LABEL: Record<CustomFieldScalarType, string> = {
  single_line_text: "a single line of text",
  multi_line_text: "text",
  integer: "a whole number",
  decimal: "a decimal number",
  boolean: "true or false",
  date: "a date (YYYY-MM-DD)",
  date_time: "a date and time with a time zone",
  url: "a web address (https://…, mailto:, tel: or a /path)",
  color: "a colour (#rrggbb)",
  json: "JSON",
  money: "an amount of money",
  product_reference: "a product id",
  variant_reference: "a variant id",
  collection_reference: "a collection id",
  media_reference: "a media id",
  object_reference: "an object record id",
};

/**
 * One item's canonical string without validations, or null when the input is
 * not that type. Money is converted from major units here.
 */
function canonicalItem(type: CustomFieldScalarType, input: unknown, context: CustomFieldCodecContext): CustomFieldResult<string> {
  const invalid = () => fail("invalid", `Enter ${TYPE_LABEL[type]}.`);
  switch (type) {
    case "single_line_text":
    case "multi_line_text": {
      const text = canonicalText(input, type === "multi_line_text");
      if (text === null) return invalid();
      const max = TEXT_MAX_LENGTH[type]!;
      return text.length > max ? fail("too_long", `Use at most ${max} characters.`, { limit: max }) : ok(text);
    }
    case "integer": {
      const value = canonicalInteger(input);
      return value === null ? invalid() : ok(value);
    }
    case "decimal": {
      const value = canonicalDecimal(input);
      return value === null ? invalid() : ok(value);
    }
    case "boolean": {
      const value = canonicalBoolean(input);
      return value === null ? invalid() : ok(value);
    }
    case "date": {
      const value = canonicalDate(input);
      return value === null ? invalid() : ok(value);
    }
    case "date_time": {
      const value = canonicalDateTime(input);
      return value === null ? invalid() : ok(value);
    }
    case "url": {
      if (typeof input === "string" && input.trim().length > CUSTOM_FIELD_URL_MAX_LENGTH) {
        return fail("too_long", `Use at most ${CUSTOM_FIELD_URL_MAX_LENGTH} characters.`, { limit: CUSTOM_FIELD_URL_MAX_LENGTH });
      }
      const value = canonicalUrl(input);
      return value === null || value.length > CUSTOM_FIELD_URL_MAX_LENGTH ? invalid() : ok(value);
    }
    case "color": {
      const value = canonicalColor(input);
      return value === null ? invalid() : ok(value);
    }
    case "json": {
      if (!isJsonValue(input)) return invalid();
      return ok(JSON.stringify(input));
    }
    case "money": {
      const decimal = canonicalDecimal(input);
      // Never rounded: more decimals than the currency has is a typo, not an amount.
      if (decimal === null || decimal.startsWith("-") || (decimal.split(".")[1] ?? "").length > context.decimalPlaces) {
        return invalid();
      }
      let minor: number;
      try {
        minor = toMinor(Number(decimal), context.decimalPlaces);
      } catch {
        return invalid();
      }
      const increment = context.priceIncrementMinor;
      if (increment !== undefined && !isIncrementMultipleMinor(minor, increment)) {
        return fail("whole_amount", priceIncrementMessage(context.currencyCode, increment));
      }
      return ok(String(minor));
    }
    case "product_reference":
    case "variant_reference":
    case "collection_reference":
    case "media_reference":
    case "object_reference": {
      const value = canonicalReference(input);
      return value === null ? invalid() : ok(value);
    }
  }
}

/** Orders two canonical items of a value-bounded type. */
function compareItems(type: CustomFieldScalarType, left: string, right: string): number {
  switch (type) {
    case "integer":
    case "money":
      return Math.sign(Number(left) - Number(right));
    case "decimal":
      return compareDecimal(left, right);
    case "date_time":
      return Math.sign(Date.parse(left) - Date.parse(right));
    default:
      return left < right ? -1 : left > right ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

/**
 * A definition's validations as stored (JSON text of this shape). `min` and
 * `max` are canonical strings: a character count for text and URL types, a
 * canonical item (money in minor units) for number, money and date types.
 * List validations apply to each item.
 */
export interface CustomFieldValidations {
  readonly to?: string;
  readonly min?: string;
  readonly max?: string;
  readonly regex?: string;
  readonly choices?: readonly string[];
}

/** Validations as the HTTP contract carries them (money bounds in major units). */
export interface CustomFieldWireValidations {
  to?: string | null;
  min?: string | number | null;
  max?: string | number | null;
  regex?: string | null;
  choices?: string[] | null;
}

export type CustomFieldBoundKind = "length" | "value";

/** What `min`/`max` bound for a type, or null when it takes none. */
export function customFieldBoundKind(type: CustomFieldType): CustomFieldBoundKind | null {
  switch (customFieldItemType(type)) {
    case "single_line_text":
    case "multi_line_text":
    case "url":
      return "length";
    case "integer":
    case "decimal":
    case "money":
    case "date":
    case "date_time":
      return "value";
    default:
      return null;
  }
}

export function customFieldSupportsRegex(type: CustomFieldType): boolean {
  const item = customFieldItemType(type);
  return item === "single_line_text" || item === "multi_line_text";
}

export function customFieldSupportsChoices(type: CustomFieldType): boolean {
  return customFieldItemType(type) === "single_line_text";
}

function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    return null;
  }
}

const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** A named Object type; kept here to avoid a codec/manifest dependency cycle. */
export function isCustomFieldObjectTarget(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const split = value.lastIndexOf(".");
  const namespace = value.slice(0, split);
  return split > 0 && (namespace === "custom" || PLUGIN_ID_PATTERN.test(namespace)) && /^[a-z][a-z0-9_]{1,47}$/.test(value.slice(split + 1));
}

/** Parses wire validations for a type into their stored form. */
export function parseCustomFieldValidations(
  type: CustomFieldType,
  input: unknown,
  context: CustomFieldCodecContext,
): CustomFieldResult<CustomFieldValidations> {
  const invalid = (message: string) => fail("invalid_validation", message);
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return invalid("Validations must be an object.");
  const raw = input as Record<string, unknown>;
  const unknownKey = Object.keys(raw).find((key) => !["min", "max", "regex", "choices", "to"].includes(key));
  if (unknownKey) return invalid(`Unknown validation ${unknownKey}.`);
  const item = customFieldItemType(type);
  const boundKind = customFieldBoundKind(type);
  const result: { min?: string; max?: string; regex?: string; choices?: string[]; to?: string } = {};
  if (item === "object_reference") {
    if (!isCustomFieldObjectTarget(raw.to)) return invalid("Choose a qualified object type for this reference.");
    result.to = raw.to;
  } else if (!isBlank(raw.to)) return invalid("Only object reference fields declare a target type.");

  for (const side of ["min", "max"] as const) {
    if (isBlank(raw[side])) continue;
    if (boundKind === null) return invalid(`This type takes no ${side === "min" ? "minimum" : "maximum"}.`);
    if (boundKind === "length") {
      const count = canonicalInteger(raw[side]);
      const max = TEXT_MAX_LENGTH[item]!;
      if (count === null || Number(count) < 0 || Number(count) > max) {
        return invalid(`The ${side === "min" ? "minimum" : "maximum"} length is a whole number from 0 to ${max}.`);
      }
      result[side] = count;
    } else {
      const bound = canonicalItem(item, raw[side], context);
      if (!bound.ok) return invalid(`The ${side === "min" ? "minimum" : "maximum"} must be ${TYPE_LABEL[item]}.`);
      result[side] = bound.value;
    }
  }
  if (result.min !== undefined && result.max !== undefined) {
    const order = boundKind === "length" ? Math.sign(Number(result.min) - Number(result.max)) : compareItems(item, result.min, result.max);
    if (order > 0) return invalid("The minimum is above the maximum.");
  }

  if (!isBlank(raw.regex)) {
    if (!customFieldSupportsRegex(type)) return invalid("Only text fields take a pattern.");
    if (typeof raw.regex !== "string" || raw.regex.length > CUSTOM_FIELD_REGEX_MAX_LENGTH || compileRegex(raw.regex) === null) {
      return invalid(`The pattern must be a valid regular expression of at most ${CUSTOM_FIELD_REGEX_MAX_LENGTH} characters.`);
    }
    result.regex = raw.regex;
  }

  if (raw.choices !== undefined && raw.choices !== null && !(Array.isArray(raw.choices) && raw.choices.length === 0)) {
    if (!customFieldSupportsChoices(type)) return invalid("Only single-line text fields take choices.");
    if (!Array.isArray(raw.choices) || raw.choices.length > CUSTOM_FIELD_CHOICES_MAX) {
      return invalid(`Give at most ${CUSTOM_FIELD_CHOICES_MAX} choices.`);
    }
    const choices: string[] = [];
    for (const choice of raw.choices) {
      const parsed = canonicalItem("single_line_text", choice, context);
      if (!parsed.ok || parsed.value === "") return invalid("Every choice is a single line of text.");
      if (choices.includes(parsed.value)) return invalid(`The choice "${parsed.value}" is listed twice.`);
      choices.push(parsed.value);
    }
    result.choices = choices;
  }
  return ok(result);
}

/** Stored validations to the HTTP contract. */
export function customFieldValidationsToWire(
  type: CustomFieldType,
  validations: CustomFieldValidations,
  context: CustomFieldCodecContext,
): CustomFieldWireValidations {
  const item = customFieldItemType(type);
  const bound = (value: string | undefined): string | number | null => {
    if (value === undefined) return null;
    if (customFieldBoundKind(type) === "length") return Number(value);
    // Bounds exist only on number, money, date and time types, whose wire form is a number or text.
    const wire = scalarWire(item, value, context);
    return typeof wire === "number" || typeof wire === "string" ? wire : null;
  };
  return {
    ...(validations.to ? { to: validations.to } : {}),
    min: bound(validations.min),
    max: bound(validations.max),
    regex: validations.regex ?? null,
    choices: validations.choices ? [...validations.choices] : null,
  };
}

/** The canonical JSON text of stored validations (keys in a fixed order, unset ones omitted). */
export function serializeCustomFieldValidations(validations: CustomFieldValidations): string {
  const ordered: Record<string, unknown> = {};
  if (validations.to !== undefined) ordered.to = validations.to;
  if (validations.min !== undefined) ordered.min = validations.min;
  if (validations.max !== undefined) ordered.max = validations.max;
  if (validations.regex !== undefined) ordered.regex = validations.regex;
  if (validations.choices !== undefined) ordered.choices = validations.choices;
  return JSON.stringify(ordered);
}

/** Stored validations from their JSON text; anything unreadable is dropped. */
export function readCustomFieldValidations(text: string | null | undefined): CustomFieldValidations {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "{}");
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const result: { min?: string; max?: string; regex?: string; choices?: string[]; to?: string } = {};
  if (isCustomFieldObjectTarget(record.to)) result.to = record.to;
  if (typeof record.min === "string") result.min = record.min;
  if (typeof record.max === "string") result.max = record.max;
  if (typeof record.regex === "string") result.regex = record.regex;
  if (Array.isArray(record.choices) && record.choices.every((choice) => typeof choice === "string")) {
    result.choices = record.choices as string[];
  }
  return result;
}

function validateItem(
  type: CustomFieldType,
  item: CustomFieldScalarType,
  value: string,
  validations: CustomFieldValidations,
  context: CustomFieldCodecContext,
  index: number | undefined,
): CustomFieldResult<string> {
  const at = index === undefined ? {} : { index };
  const boundKind = customFieldBoundKind(type);
  const wire = (bound: string) => (boundKind === "length" ? Number(bound) : scalarWire(item, bound, context) as string | number);
  if (validations.min !== undefined) {
    const below = boundKind === "length" ? value.length < Number(validations.min) : compareItems(item, value, validations.min) < 0;
    if (below) {
      return boundKind === "length"
        ? fail("too_short", `Use at least ${validations.min} characters.`, { ...at, limit: wire(validations.min) })
        : fail("too_small", `The minimum is ${String(wire(validations.min))}.`, { ...at, limit: wire(validations.min) });
    }
  }
  if (validations.max !== undefined) {
    const above = boundKind === "length" ? value.length > Number(validations.max) : compareItems(item, value, validations.max) > 0;
    if (above) {
      return boundKind === "length"
        ? fail("too_long", `Use at most ${validations.max} characters.`, { ...at, limit: wire(validations.max) })
        : fail("too_large", `The maximum is ${String(wire(validations.max))}.`, { ...at, limit: wire(validations.max) });
    }
  }
  if (validations.regex !== undefined && customFieldSupportsRegex(type)) {
    const pattern = compileRegex(validations.regex);
    if (pattern && !pattern.test(value)) return fail("pattern", "The value does not match the required pattern.", at);
  }
  if (validations.choices !== undefined && customFieldSupportsChoices(type) && !validations.choices.includes(value)) {
    return fail("not_a_choice", "Choose one of the listed options.", at);
  }
  return ok(value);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface CustomFieldValueDefinition {
  readonly type: CustomFieldType;
  readonly validations: CustomFieldValidations;
}

/** `null`, `undefined`, blank text and an empty list clear a value. */
export function isCustomFieldEmptyInput(input: unknown): boolean {
  return input === undefined || input === null
    || (typeof input === "string" && input.trim() === "")
    || (Array.isArray(input) && input.length === 0);
}

/**
 * A wire value to its stored canonical text, validated against the
 * definition; `value: null` means clear. Reference ids are checked for shape
 * only: whether the records exist is the writer's job (`customFieldReferenceIds`).
 */
export function parseCustomFieldValue(
  definition: CustomFieldValueDefinition,
  input: unknown,
  context: CustomFieldCodecContext,
): CustomFieldResult<string | null> {
  if (isCustomFieldEmptyInput(input)) return ok(null);
  const item = customFieldItemType(definition.type);
  const parseOne = (raw: unknown, index?: number): CustomFieldResult<string> => {
    if (isCustomFieldEmptyInput(raw) && index !== undefined) {
      return fail("invalid", "Remove the empty item or fill it in.", { index });
    }
    const canonical = canonicalItem(item, raw, context);
    if (!canonical.ok) return { ok: false, issue: index === undefined ? canonical.issue : { ...canonical.issue, index } };
    return validateItem(definition.type, item, canonical.value, definition.validations, context, index);
  };

  let stored: string;
  if (isCustomFieldListType(definition.type)) {
    if (!Array.isArray(input)) return fail("invalid", `Enter a list of ${TYPE_LABEL[item]} values.`);
    if (input.length > CUSTOM_FIELD_LIST_MAX_ITEMS) {
      return fail("too_many_items", `Use at most ${CUSTOM_FIELD_LIST_MAX_ITEMS} items.`, { limit: CUSTOM_FIELD_LIST_MAX_ITEMS });
    }
    const items: string[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const parsed = parseOne(input[index], index);
      if (!parsed.ok) return parsed;
      items.push(parsed.value);
    }
    stored = JSON.stringify(items);
  } else {
    const parsed = parseOne(input);
    if (!parsed.ok) return parsed;
    stored = parsed.value;
  }
  if (stored.length > CUSTOM_FIELD_VALUE_MAX_LENGTH) {
    return fail("too_long", `The value is too large (at most ${CUSTOM_FIELD_VALUE_MAX_LENGTH} characters stored).`, { limit: CUSTOM_FIELD_VALUE_MAX_LENGTH });
  }
  return ok(stored);
}

function scalarWire(type: CustomFieldScalarType, stored: string, context: CustomFieldCodecContext): CustomFieldWireValue {
  switch (type) {
    case "integer":
      return Number(stored);
    case "boolean":
      return stored === "true";
    case "json":
      return JSON.parse(stored) as CustomFieldJson;
    case "money":
      return fromMinor(Number(stored), context.decimalPlaces);
    default:
      return stored;
  }
}

/** Whether a stored item is canonical for its type (so the wire form is truthful). */
function isStoredItem(type: CustomFieldScalarType, stored: unknown, context: CustomFieldCodecContext): stored is string {
  if (typeof stored !== "string") return false;
  if (type === "money") return /^(0|[1-9]\d{0,15})$/.test(stored) && Number.isSafeInteger(Number(stored));
  if (type === "json") {
    try {
      JSON.parse(stored);
      return true;
    } catch {
      return false;
    }
  }
  const canonical = canonicalItem(type, stored, context);
  return canonical.ok && canonical.value === stored;
}

/**
 * A stored value to the HTTP contract, or null when the stored text is not a
 * canonical value of the type (never guessed at).
 */
export function customFieldWireValue(
  type: CustomFieldType,
  stored: string,
  context: CustomFieldCodecContext,
): CustomFieldWireValue | null {
  const item = customFieldItemType(type);
  if (!isCustomFieldListType(type)) return isStoredItem(item, stored, context) ? scalarWire(item, stored, context) : null;
  let items: unknown;
  try {
    items = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(items) || !items.every((value) => isStoredItem(item, value, context))) return null;
  return (items as string[]).map((value) => scalarWire(item, value, context));
}

/** The record ids a stored reference value names (empty for other types). */
export function customFieldReferenceIds(type: CustomFieldType, stored: string): string[] {
  if (customFieldReferenceTarget(type) === null) return [];
  if (!isCustomFieldListType(type)) return [stored];
  try {
    const items = JSON.parse(stored) as unknown;
    return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
