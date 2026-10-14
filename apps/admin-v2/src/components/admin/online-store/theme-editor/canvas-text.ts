import { storefrontSettingAt, storefrontSettingWith, type StorefrontSection, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { THEME_APP_TEXT_FIELD, type ThemeTextField } from "@scalius/shared/theme-editor-bridge";
import { appFieldValue } from "../schema-form/app-settings";
import { sectionSettingSpec } from "../schema-form/registry-forms";
import { type SettingSpec } from "../schema-form/introspect";
import type { AppSectionEntry } from "./editor-state";
import { pageSections, withPageSections, type EditorPage } from "./editor-pages";

/** The manifests' own limits when a text setting names none. */
const APP_TEXT_MAX = { text: 200, textarea: 2000 } as const;
const NO_APPS: ReadonlyMap<string, AppSectionEntry> = new Map();

/**
 * An app section's text setting: a `text` or `textarea` field its app
 * declares, on a section its storefront module draws (the SDK's
 * `editable(context, key)` marks it). `layout` is the section's app, so a
 * section that changed app is never written.
 */
function appTextField(section: Extract<StorefrontSection, { type: "app" }>, field: string, apps: ReadonlyMap<string, AppSectionEntry>) {
  const entry = apps.get(section.settings.app);
  const setting = entry && THEME_APP_TEXT_FIELD.test(field)
    ? entry.section.settings.find((each) => each.key === field && (each.type === "text" || each.type === "textarea"))
    : undefined;
  const value = setting ? appFieldValue(setting, section.settings.values) : undefined;
  if (!setting || (value !== undefined && typeof value !== "string")) return null;
  const multiline = setting.type === "textarea";
  // A long text's paragraphs are the app's markup: it draws them again instead of a patch.
  return { field: field as ThemeTextField, value: value ?? "", maxLength: setting.maxLength ?? APP_TEXT_MAX[setting.type as "text" | "textarea"],
    multiline, patch: !multiline, layout: section.settings.app, label: setting.label };
}

/** Only merchant-authored scalar copy; repeated blocks need original item identity. */
export function canvasTextField(section: StorefrontSection, field: string, apps: ReadonlyMap<string, AppSectionEntry> = NO_APPS) {
  if (section.hidden) return null;
  if (section.type === "app") return appTextField(section, field, apps);
  const allowed = section.type === "banner" ? ["heading", "text", "cta.label"]
    : section.type === "editorial" && ["rich-text", "image-with-text"].includes(section.settings.layout) ? ["heading", "body"]
      : section.type === "faq" ? ["heading"] : [];
  if (!allowed.includes(field)) return null;
  let spec: SettingSpec | undefined = sectionSettingSpec(section.type);
  let value: unknown = section.settings;
  for (const key of field.split(".")) {
    if (spec?.kind === "variants") {
      const variant = storefrontSettingAt(value, spec.key);
      spec = spec.options.find((option) => option.value === variant)?.spec;
    }
    if (spec?.kind !== "object") return null;
    spec = spec.fields.find((entry) => entry.key === key)?.spec;
    value = storefrontSettingAt(value, key);
  }
  if (spec?.kind !== "text" || typeof value !== "string") return null;
  return { field: field as ThemeTextField, value, maxLength: spec.max ?? 8000, multiline: spec.max === null || spec.max > 200,
    patch: field !== "body", layout: "layout" in section.settings ? section.settings.layout : null, label: null };
}

/**
 * The settings control a canvas field stands for (SectionSettings and
 * AppSectionSettings ids): `theme-section-<id>-<path with dashes>`, or
 * `theme-section-<id>-values-<key>` in an app section.
 */
export function canvasTextControlId(section: StorefrontSection, field: string): string {
  return section.type === "app" ? `theme-section-${section.id}-values-${field}` : `theme-section-${section.id}-${field.replace(/\./g, "-")}`;
}

export interface CanvasTextTarget {
  page: EditorPage;
  id: string;
  type: StorefrontSection["type"];
  field: ThemeTextField;
  layout: string | null;
  baseline: string;
}
export type CanvasTextResult = { ok: true; theme: StorefrontThemeDocument }
  | { ok: false; reason: "missing" | "changed" | "too-long"; current?: string };

/** A page-explicit compare-and-set; never write an old canvas edit into a new page. */
export function commitCanvasText(
  theme: StorefrontThemeDocument,
  target: CanvasTextTarget,
  value: string,
  baseline = target.baseline,
  apps: ReadonlyMap<string, AppSectionEntry> = NO_APPS,
): CanvasTextResult {
  const sections = pageSections(theme, target.page);
  const section = sections?.find((entry) => entry.id === target.id);
  const field = section && canvasTextField(section, target.field, apps);
  if (!sections || !section || !field || section.type !== target.type || field.layout !== target.layout) return { ok: false, reason: "missing" };
  if (field.value !== baseline) return { ok: false, reason: "changed", current: field.value };
  if (value.length > field.maxLength) return { ok: false, reason: "too-long" };
  if (value === field.value) return { ok: true, theme };
  const next = section.type === "app"
    ? { ...section, settings: { ...section.settings, values: { ...section.settings.values, [target.field]: value } } }
    : { ...section, settings: storefrontSettingWith(section.settings, target.field, value) } as StorefrontSection;
  return { ok: true, theme: withPageSections(theme, target.page, sections.map((entry) => entry.id === target.id ? next : entry)) };
}
