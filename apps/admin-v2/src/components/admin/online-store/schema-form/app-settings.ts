/**
 * The settings of an app's theme section, theme slot or product-page block,
 * as data: the fields the app declares (from the theme workspace), the
 * values a new placement starts with, the value each field shows, and the
 * checks the plugin settings schema makes (`validatePluginSettingValues` in
 * `@scalius/shared/plugins/settings-schema`), so the editor never saves a
 * value the app would refuse. The storefront resolves the same values
 * against the app's manifest when it renders (`resolvePluginSettingValues`):
 * a key that is absent takes the field's default, `null` is cleared. A
 * `list` item's fields take no defaults there, so an item holds every value
 * it shows.
 */
import { z } from "zod";
import {
  PLUGIN_LINK,
  PLUGIN_MEDIA_ID,
  PLUGIN_PRODUCT_ID,
  PLUGIN_PRODUCT_SOURCE,
} from "@scalius/shared/plugins/settings-schema";
import type { ThemeAppSettingField } from "~/lib/api-query-options/online-store";

/** One item of a `list` setting: its fields' values by key. */
export type AppSettingItem = Record<string, string | number | boolean | null>;
export type AppSettingValue = string | number | boolean | string[] | AppSettingItem[] | null;
export type AppSettingValues = Record<string, AppSettingValue>;
/** A field of a `list` setting's items: drawn and checked as a setting of its own. */
export type ThemeAppSettingItemField = NonNullable<ThemeAppSettingField["fields"]>[number];

export type AppSettingProblem =
  | { kind: "required" }
  | { kind: "tooLong"; max: number }
  | { kind: "number" }
  | { kind: "wholeNumber" }
  | { kind: "atLeast"; min: number }
  | { kind: "atMost"; max: number }
  | { kind: "https" }
  | { kind: "email" }
  | { kind: "color" }
  | { kind: "option" }
  | { kind: "link" }
  /** A collection or category source without its collection or category yet. */
  | { kind: "products"; source: "collection" | "category" }
  | { kind: "fewItems"; min: number }
  | { kind: "manyItems"; max: number }
  /** A `list` item has a field to fix (each field says which). */
  | { kind: "items" }
  /** A stored value of another type (the app changed the setting since). */
  | { kind: "invalid" };

const COLOR = /^#[0-9a-f]{6}$/;
/** The email pattern the plugin settings schema checks with (zod's). */
const EMAIL = z.regexes.email;
const URL_MAX = 2048;
const EMAIL_MAX = 254;
/** The manifest's own limits when a text field names none. */
const TEXT_MAX = { text: 200, textarea: 2000 } as const;

const LINK_MAX = 2048;
/** A collection or category source while its record is not chosen yet (`collection:`). */
const UNCHOSEN_SOURCE = /^(collection|category):$/;

const own = (values: Readonly<Record<string, unknown>>, key: string) => Object.prototype.hasOwnProperty.call(values, key);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isItem = (value: unknown): value is AppSettingItem => typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.values(value).every((each) => each === null || ["string", "number", "boolean"].includes(typeof each));

/** The fields a theme placement draws: every one but secrets (an app never offers those to the theme). */
export function themeAppFields(fields: readonly ThemeAppSettingField[]): ThemeAppSettingField[] {
  return fields.filter((field) => field.type !== "secret");
}

/** A field's default, when the app declares one of the field's own type. */
export function appFieldDefault(field: ThemeAppSettingField): AppSettingValue | undefined {
  const value: unknown = field.default;
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "multiselect":
      return isStrings(value) ? [...value] : undefined;
    case "list":
      return Array.isArray(value) && value.every(isItem) ? value.map((item) => ({ ...item })) : undefined;
    case "secret":
      return undefined;
    default:
      return typeof value === "string" ? value : undefined;
  }
}

/**
 * What a new placement starts with: each field's default (fields without one
 * stay unset). A new `list` item starts the same way from its item fields.
 */
export function appSettingDefaults(fields: readonly ThemeAppSettingField[]): AppSettingValues {
  const values: AppSettingValues = {};
  for (const field of themeAppFields(fields)) {
    const fallback = appFieldDefault(field);
    if (fallback !== undefined) values[field.key] = fallback;
  }
  return values;
}

/** A new item of a `list` setting: its fields' defaults. */
export function appListItemDefaults(field: ThemeAppSettingField): AppSettingItem {
  return appSettingDefaults(field.fields ?? []) as AppSettingItem;
}

/**
 * The value a field has on the store: the stored one when the key is there
 * (`null` is cleared), the field's default when it is not.
 */
export function appFieldValue(field: ThemeAppSettingField, values: Readonly<Record<string, unknown>>): unknown {
  return own(values, field.key) && values[field.key] !== undefined ? values[field.key] : appFieldDefault(field);
}

function textMax(field: ThemeAppSettingField): number {
  return field.maxLength ?? (field.type === "textarea" ? TEXT_MAX.textarea : TEXT_MAX.text);
}

/** Each field's problem in one `list` item, by key (a field missing from the item is unset). */
export function appListItemProblems(field: ThemeAppSettingField, item: AppSettingItem): Map<string, AppSettingProblem> {
  const problems = new Map<string, AppSettingProblem>();
  for (const each of field.fields ?? []) {
    const problem = appSettingProblem(each, item[each.key]);
    if (problem) problems.set(each.key, problem);
  }
  return problems;
}

function httpsAddress(value: string): boolean {
  if (value.length > URL_MAX || !value.startsWith("https://")) return false;
  try {
    return new URL(value).hostname !== "";
  } catch {
    return false;
  }
}

/** One field's problem with its value on the store, or null when the app accepts it. */
export function appSettingProblem(field: ThemeAppSettingField, value: unknown): AppSettingProblem | null {
  const empty = value === undefined || value === null || value === ""
    // Nothing chosen in a required multi-choice is nothing set; an empty list is a list (its minimum says).
    || (field.type === "multiselect" && Array.isArray(value) && value.length === 0);
  if (empty) return field.required ? { kind: "required" } : null;
  switch (field.type) {
    case "text":
    case "textarea": {
      if (typeof value !== "string") return { kind: "invalid" };
      const max = textMax(field);
      return value.length > max ? { kind: "tooLong", max } : null;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { kind: "number" };
      if (field.integer && !Number.isInteger(value)) return { kind: "wholeNumber" };
      if (field.min !== null && value < field.min) return { kind: "atLeast", min: field.min };
      if (field.max !== null && value > field.max) return { kind: "atMost", max: field.max };
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : { kind: "invalid" };
    case "select":
      if (typeof value !== "string") return { kind: "invalid" };
      return (field.options ?? []).some((option) => option.value === value) ? null : { kind: "option" };
    case "multiselect": {
      if (!isStrings(value)) return { kind: "invalid" };
      const options = new Set((field.options ?? []).map((option) => option.value));
      return value.length <= options.size && value.every((item) => options.has(item)) ? null : { kind: "option" };
    }
    case "url":
      return typeof value === "string" && httpsAddress(value) ? null : { kind: "https" };
    case "email":
      return typeof value === "string" && value.length <= EMAIL_MAX && EMAIL.test(value) ? null : { kind: "email" };
    case "color":
      return typeof value === "string" && COLOR.test(value) ? null : { kind: "color" };
    case "image":
      return typeof value === "string" && PLUGIN_MEDIA_ID.test(value) ? null : { kind: "invalid" };
    case "product":
      return typeof value === "string" && PLUGIN_PRODUCT_ID.test(value) ? null : { kind: "invalid" };
    case "products": {
      if (typeof value !== "string") return { kind: "invalid" };
      const unchosen = UNCHOSEN_SOURCE.exec(value)?.[1] as "collection" | "category" | undefined;
      if (unchosen) return { kind: "products", source: unchosen };
      return PLUGIN_PRODUCT_SOURCE.test(value) ? null : { kind: "invalid" };
    }
    case "link":
      return typeof value === "string" && value.length <= LINK_MAX && PLUGIN_LINK.test(value) ? null : { kind: "link" };
    case "list": {
      if (!Array.isArray(value) || !value.every(isItem)) return { kind: "invalid" };
      // An item names only its declared fields (the app reads a list with others as unset).
      const keys = new Set((field.fields ?? []).map((each) => each.key));
      if (value.some((item) => Object.keys(item).some((key) => !keys.has(key)))) return { kind: "invalid" };
      if (field.min !== null && value.length < field.min) return { kind: "fewItems", min: field.min };
      if (field.max !== null && value.length > field.max) return { kind: "manyItems", max: field.max };
      return value.some((item) => appListItemProblems(field, item).size > 0) ? { kind: "items" } : null;
    }
    case "secret":
      return null;
  }
}

/** Every field's problem, by setting key. */
export function appSettingProblems(fields: readonly ThemeAppSettingField[], values: Readonly<Record<string, unknown>>): Map<string, AppSettingProblem> {
  const problems = new Map<string, AppSettingProblem>();
  for (const field of themeAppFields(fields)) {
    const problem = appSettingProblem(field, appFieldValue(field, values));
    if (problem) problems.set(field.key, problem);
  }
  return problems;
}

export function appValuesInvalid(fields: readonly ThemeAppSettingField[], values: Readonly<Record<string, unknown>>): boolean {
  return appSettingProblems(fields, values).size > 0;
}

/**
 * The values with one setting changed (`undefined` takes it back to the
 * app's default). Keys the app no longer declares are dropped; the rest stay
 * as stored, so a setting never touched keeps following the app's default.
 */
export function withAppSettingValue(
  fields: readonly ThemeAppSettingField[],
  values: Readonly<Record<string, AppSettingValue>>,
  key: string,
  value: AppSettingValue | undefined,
): AppSettingValues {
  const next: AppSettingValues = {};
  for (const field of themeAppFields(fields)) {
    if (field.key === key) {
      if (value !== undefined) next[key] = value;
    } else if (own(values, field.key) && values[field.key] !== undefined) {
      next[field.key] = values[field.key]!;
    }
  }
  return next;
}
