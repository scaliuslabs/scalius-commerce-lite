/**
 * The settings of an app's theme section or product-page block, as data:
 * the fields the app declares (from the theme workspace), the values a new
 * placement starts with, the value each field shows, and the checks the
 * plugin settings schema makes (`validatePluginSettingValues` in
 * `@scalius/shared/plugins/settings-schema`), so the editor never saves a
 * value the app would refuse. The storefront resolves the same values
 * against the app's manifest when it renders (`resolvePluginSettingValues`):
 * a key that is absent takes the field's default, `null` is cleared.
 */
import { z } from "zod";
import type { ThemeAppSettingField } from "~/lib/api-query-options/online-store";

export type AppSettingValue = string | number | boolean | string[] | null;
export type AppSettingValues = Record<string, AppSettingValue>;

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
  /** A stored value of another type (the app changed the setting since). */
  | { kind: "invalid" };

const COLOR = /^#[0-9a-f]{6}$/;
/** The email pattern the plugin settings schema checks with (zod's). */
const EMAIL = z.regexes.email;
const URL_MAX = 2048;
const EMAIL_MAX = 254;
/** The manifest's own limits when a text field names none. */
const TEXT_MAX = { text: 200, textarea: 2000 } as const;

const own = (values: Readonly<Record<string, unknown>>, key: string) => Object.prototype.hasOwnProperty.call(values, key);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

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
    case "secret":
      return undefined;
    default:
      return typeof value === "string" ? value : undefined;
  }
}

/** What a new placement starts with: each field's default (fields without one stay unset). */
export function appSettingDefaults(fields: readonly ThemeAppSettingField[]): AppSettingValues {
  const values: AppSettingValues = {};
  for (const field of themeAppFields(fields)) {
    const fallback = appFieldDefault(field);
    if (fallback !== undefined) values[field.key] = fallback;
  }
  return values;
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
    // Nothing chosen in a required multi-choice is nothing set.
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
