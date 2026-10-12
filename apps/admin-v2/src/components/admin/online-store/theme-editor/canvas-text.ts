import { storefrontSettingAt, storefrontSettingWith, type StorefrontSection, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { type ThemeTextField } from "@scalius/shared/theme-editor-bridge";
import { sectionSettingSpec } from "../schema-form/registry-forms";
import { type SettingSpec } from "../schema-form/introspect";
import { pageSections, withPageSections, type EditorPage } from "./editor-pages";

/** Only merchant-authored scalar copy; repeated blocks need original item identity. */
export function canvasTextField(section: StorefrontSection, field: string) {
  const allowed = section.type === "banner" ? ["heading", "text", "cta.label"]
    : section.type === "editorial" && ["rich-text", "image-with-text"].includes(section.settings.layout) ? ["heading", "body"]
      : section.type === "faq" ? ["heading"] : [];
  if (section.hidden || section.type === "app" || !allowed.includes(field)) return null;
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
    patch: field !== "body", layout: "layout" in section.settings ? section.settings.layout : null };
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
export function commitCanvasText(theme: StorefrontThemeDocument, target: CanvasTextTarget, value: string, baseline = target.baseline): CanvasTextResult {
  const sections = pageSections(theme, target.page);
  const section = sections?.find((entry) => entry.id === target.id);
  const field = section && canvasTextField(section, target.field);
  if (!sections || !section || !field || section.type !== target.type || field.layout !== target.layout) return { ok: false, reason: "missing" };
  if (field.value !== baseline) return { ok: false, reason: "changed", current: field.value };
  if (value.length > field.maxLength) return { ok: false, reason: "too-long" };
  if (value === field.value) return { ok: true, theme };
  const next = { ...section, settings: storefrontSettingWith(section.settings, target.field, value) } as StorefrontSection;
  return { ok: true, theme: withPageSections(theme, target.page, sections.map((entry) => entry.id === target.id ? next : entry)) };
}
