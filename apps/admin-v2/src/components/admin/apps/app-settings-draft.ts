// The app settings form, as data: a draft from the API's fields and values,
// the checks the API's schema makes (so most problems show before Save), and
// the body Save sends. A secret is never read back: its draft starts empty,
// and the body carries it only when it changes (a typed value sets it, null
// clears it, leaving it out keeps the saved one).
import type { AppDetail, AppSettingField, AppSettingValue } from "~/lib/api-query-options/apps";

export interface SettingsDraft {
  /** Every plain field: text-like as typed (numbers too), switches, multi-choice lists. */
  values: Record<string, string | boolean | string[]>;
  /** Secret edits: a typed replacement, or null to remove the saved one. Absent keeps it. */
  secrets: Record<string, string | null>;
}

export type SettingProblem =
  | { kind: "required" }
  | { kind: "tooLong"; max: number }
  | { kind: "number" }
  | { kind: "wholeNumber" }
  | { kind: "atLeast"; min: number }
  | { kind: "atMost"; max: number }
  | { kind: "https" }
  | { kind: "email" }
  | { kind: "color" };

const COLOR = /^#[0-9a-f]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_MAX = 4096;

export function draftFromSettings(settings: AppDetail["settings"]): SettingsDraft {
  const values: SettingsDraft["values"] = {};
  for (const field of settings.fields) {
    if (field.type === "secret") continue;
    const stored = settings.values[field.key];
    const value = stored === undefined || stored === null ? field.default : stored;
    if (field.type === "boolean") values[field.key] = value === true;
    else if (field.type === "multiselect") values[field.key] = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    else if (field.type === "number") values[field.key] = typeof value === "number" ? String(value) : "";
    else values[field.key] = typeof value === "string" ? value : "";
  }
  return { values, secrets: {} };
}

export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function text(draft: SettingsDraft, key: string): string {
  const value = draft.values[key];
  return typeof value === "string" ? value : "";
}

/** One field's problem, mirroring the API's settings schema; null when it's fine. */
export function checkSetting(field: AppSettingField, draft: SettingsDraft, secretIsSet: boolean): SettingProblem | null {
  if (field.type === "secret") {
    const edit = draft.secrets[field.key];
    if (typeof edit === "string" && edit !== "") return edit.length > SECRET_MAX ? { kind: "tooLong", max: SECRET_MAX } : null;
    const kept = edit === undefined && secretIsSet;
    return field.required && !kept ? { kind: "required" } : null;
  }
  if (field.type === "boolean") return null;
  if (field.type === "multiselect") {
    const chosen = draft.values[field.key];
    return field.required && (!Array.isArray(chosen) || chosen.length === 0) ? { kind: "required" } : null;
  }
  const raw = text(draft, field.key);
  const value = raw.trim();
  // Only spaces counts as empty (Save sends null for it).
  if (value === "") return field.required ? { kind: "required" } : null;
  switch (field.type) {
    case "text":
    case "textarea":
      return field.maxLength !== null && raw.length > field.maxLength ? { kind: "tooLong", max: field.maxLength } : null;
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) return { kind: "number" };
      if (field.integer && !Number.isInteger(number)) return { kind: "wholeNumber" };
      if (field.min !== null && number < field.min) return { kind: "atLeast", min: field.min };
      if (field.max !== null && number > field.max) return { kind: "atMost", max: field.max };
      return null;
    }
    case "url":
      try {
        new URL(value);
      } catch {
        return { kind: "https" };
      }
      return value.startsWith("https://") ? null : { kind: "https" };
    case "email":
      return EMAIL.test(value) ? null : { kind: "email" };
    case "color":
      return COLOR.test(value.toLowerCase()) ? null : { kind: "color" };
    default:
      return null;
  }
}

/** Every field's problem, by key. */
export function checkSettings(fields: readonly AppSettingField[], draft: SettingsDraft, secrets: Record<string, boolean>): Record<string, SettingProblem> {
  const problems: Record<string, SettingProblem> = {};
  for (const field of fields) {
    const problem = checkSetting(field, draft, secrets[field.key] === true);
    if (problem) problems[field.key] = problem;
  }
  return problems;
}

/** The settings document Save sends: every plain field, and only the secrets that change. */
export function settingsBody(fields: readonly AppSettingField[], draft: SettingsDraft): Record<string, AppSettingValue> {
  const body: Record<string, AppSettingValue> = {};
  for (const field of fields) {
    if (field.type === "secret") {
      const edit = draft.secrets[field.key];
      if (edit === null) body[field.key] = null;
      else if (typeof edit === "string" && edit !== "") body[field.key] = edit;
      continue;
    }
    const value = draft.values[field.key];
    if (field.type === "boolean") {
      body[field.key] = value === true;
      continue;
    }
    if (field.type === "multiselect") {
      body[field.key] = Array.isArray(value) ? value : [];
      continue;
    }
    const raw = typeof value === "string" ? value : "";
    const trimmed = raw.trim();
    if (trimmed === "") body[field.key] = null;
    else if (field.type === "number") body[field.key] = Number(trimmed);
    else if (field.type === "color") body[field.key] = trimmed.toLowerCase();
    else if (field.type === "text" || field.type === "textarea") body[field.key] = raw;
    else body[field.key] = trimmed;
  }
  return body;
}

/** Whether a field is set (a secret: saved; anything else: a value or default). Status only, never the value. */
export function settingIsSet(app: Pick<AppDetail, "settings">, key: string): boolean {
  const field = app.settings.fields.find((entry) => entry.key === key);
  if (!field) return false;
  if (field.type === "secret") return app.settings.secrets[key] === true;
  const value = app.settings.values[key] ?? field.default;
  return !(value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0));
}

/** A provider is configured when every key its readiness needs is set (status only, never a value). */
export function providerConfigured(app: Pick<AppDetail, "settings">, provider: Pick<AppDetail["providers"][number], "required">): boolean {
  return provider.required.every((key) => settingIsSet(app, key));
}
