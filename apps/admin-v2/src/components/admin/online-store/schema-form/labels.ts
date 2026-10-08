/**
 * Setting labels come from i18n keys derived from the registry: a section's
 * `title` reads `s.<type>.title`, then the shared `f.title`; a block
 * variant's `emi` reads `b.buyBox.spec.emi`, then
 * `b.buyBox.emi`, then `f.emi`. Choices add the value
 * (`s.hero.layout.split`), lists their item name (`.item`, "Slide {number}"),
 * optional choices their unset option (`.unset`), and any key may carry
 * help (`.help`). `labelRequirements` lists what a schema needs, so a test
 * proves every registry setting is named in English and Bangla.
 */
import { themeSettingMessages } from "~/i18n/theme-settings";
import type { SettingSpec } from "./introspect";

export type SettingMessageKey = keyof (typeof themeSettingMessages)["en"];

/** Where a form's labels come from, most specific first; the shared `f` scope is always last. */
export type LabelScope = readonly string[];

export const sectionLabelScope = (type: string): LabelScope => [`s.${type}`];
export const blockLabelScope = (slot: string, variant: string): LabelScope => [`b.${slot}.${variant}`, `b.${slot}`];

const KEYS = new Set<string>(Object.keys(themeSettingMessages.en));

/** The most specific message key for a setting path (`slides.alt`), plus an optional suffix (`help`, a choice value). */
export function settingLabelKey(scope: LabelScope, path: string, suffix?: string): SettingMessageKey | null {
  const tail = suffix === undefined ? "" : `.${suffix}`;
  const segments = path.split(".");
  // The shared scope matches the path, then ever shorter ends of it
  // (`tabs.source.kind` reads `f.source.kind`, then `f.kind`).
  const shared = segments.map((_, index) => `f.${segments.slice(index).join(".")}${tail}`);
  const candidates = [...scope.map((prefix) => `${prefix}.${path}${tail}`), ...shared];
  return (candidates.find((key) => KEYS.has(key)) ?? null) as SettingMessageKey | null;
}

/** The help under a label (`<label key>.help`), from the same scope as the label. */
export function settingHelpKey(labelKey: SettingMessageKey | null): SettingMessageKey | null {
  if (!labelKey) return null;
  const key = `${labelKey}.help`;
  return KEYS.has(key) ? (key as SettingMessageKey) : null;
}

/** A label the form shows: a setting (`label`), a choice value, a list's item name, an optional choice's unset option. */
export interface LabelRequirement {
  path: string;
  suffix?: string;
}

const join = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);

/** Every label a settings spec needs. */
export function labelRequirements(spec: SettingSpec, path = ""): LabelRequirement[] {
  switch (spec.kind) {
    case "object":
      return spec.fields.flatMap((field) => [
        { path: join(path, field.key) },
        ...labelRequirements(field.spec, join(path, field.key)),
      ]);
    case "choice":
      // Numbers show as numbers; a single-value optional choice needs the
      // name of leaving it unset ("Same order as computers").
      return [
        ...(spec.values.length > 1 || spec.optional
          ? spec.values.filter((value) => typeof value === "string").map((value) => ({ path, suffix: String(value) }))
          : []),
        ...(spec.optional && spec.values.length === 1 ? [{ path, suffix: "unset" }] : []),
      ];
    case "list":
      return [
        ...(spec.item.kind === "object" || spec.item.kind === "variants" ? [{ path, suffix: "item" }] : []),
        ...labelRequirements(spec.item, path),
      ];
    case "variants": {
      // Nested variants (a product source) are named by their own field;
      // the root ones (the editorial layout) by their discriminator.
      const key = join(path, spec.key);
      return [
        ...(path ? [] : [{ path: key }]),
        ...spec.options.map((option) => ({ path: key, suffix: option.value })),
        ...spec.options.flatMap((option) => labelRequirements(
          { ...option.spec, fields: option.spec.fields.filter((field) => field.key !== spec.key) },
          path,
        )),
      ];
    }
    default:
      return [];
  }
}
