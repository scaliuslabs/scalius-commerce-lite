import {
  STOREFRONT_STYLE_PRESETS,
  storefrontStylePresetTheme,
  type StorefrontHomepageSection,
  type StorefrontStylePresetKey,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";

/** The order with `section` moved one place up (-1) or down (+1); unchanged at either end. */
export function moveHomepageSection(
  order: readonly StorefrontHomepageSection[],
  section: StorefrontHomepageSection,
  delta: -1 | 1,
): StorefrontHomepageSection[] {
  const next = [...order];
  const from = next.indexOf(section);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Same theme choices, whatever order the saved document lists its keys in. */
export function sameTheme(left: StorefrontThemeSettings, right: StorefrontThemeSettings): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Each Style's complete look, for previews and matching (apply a fresh `storefrontStylePresetTheme`). */
export const STYLE_PRESET_THEMES: ReadonlyArray<{ key: StorefrontStylePresetKey; theme: StorefrontThemeSettings }> =
  STOREFRONT_STYLE_PRESETS.map(({ key }) => ({ key, theme: storefrontStylePresetTheme(key) }));

/** The Style whose every choice the theme still matches, if any. */
export function selectedStylePreset(theme: StorefrontThemeSettings): StorefrontStylePresetKey | null {
  return STYLE_PRESET_THEMES.find((preset) => sameTheme(preset.theme, theme))?.key ?? null;
}
