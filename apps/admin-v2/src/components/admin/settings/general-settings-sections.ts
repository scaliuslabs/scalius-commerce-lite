import {
  HEADER_BUILDER_PANELS,
  type HeaderBuilderPanel,
} from "../header-builder/types";
import {
  FOOTER_BUILDER_PANELS,
  type FooterBuilderPanel,
} from "../footer-builder/types";

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

export type GeneralSettingsPanel = HeaderBuilderPanel | FooterBuilderPanel;

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

export function normalizeGeneralSettingsPanel(
  section: GeneralSettingsSection,
  value: unknown,
): GeneralSettingsPanel | undefined {
  const panels = section === "header"
    ? HEADER_BUILDER_PANELS
    : section === "footer"
      ? FOOTER_BUILDER_PANELS
      : null;

  if (!panels) return undefined;
  return typeof value === "string" && (panels as readonly string[]).includes(value)
    ? (value as GeneralSettingsPanel)
    : panels[0];
}
