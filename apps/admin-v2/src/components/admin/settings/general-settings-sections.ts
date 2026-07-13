export const GENERAL_SETTINGS_SECTIONS = [
  "header",
  "footer",
  "seo",
  "storefront",
  "email",
  "currency",
  "media",
  "business",
  "countries",
  "auth",
  "security",
  "scanner",
] as const;

export type GeneralSettingsSection =
  (typeof GENERAL_SETTINGS_SECTIONS)[number];

export const DEFAULT_GENERAL_SETTINGS_SECTION: GeneralSettingsSection =
  "header";

export function normalizeGeneralSettingsSection(
  value: unknown,
): GeneralSettingsSection {
  return typeof value === "string" &&
    GENERAL_SETTINGS_SECTIONS.includes(value as GeneralSettingsSection)
    ? (value as GeneralSettingsSection)
    : DEFAULT_GENERAL_SETTINGS_SECTION;
}
