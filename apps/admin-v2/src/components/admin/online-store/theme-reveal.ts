/**
 * "1 setting to fix": where a held-back part of the theme document is edited,
 * so the editor can open that tab and group, scroll to the field and focus
 * it. Section settings have their own path (their form ids); this is the
 * theme-wide parts (colours, brand, product cards, the announcement bar,
 * the units app skins draw and the one-product homepage).
 */
import { createContext, useContext } from "react";
import { isStorefrontThemeHexColor, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { COLOR_FIELD_IDS, COLOR_ROLE_TOKEN, THEME_FIELD_IDS, themeContrastProblems, type ColorRole } from "./theme-settings";

/** The groups of the Theme settings tab that hold fields which can be invalid. */
export type ThemeSettingsGroup = "colors" | "logo" | "productCards";

export interface ThemeRevealRequest {
  group: ThemeSettingsGroup;
  /** Changes on every click, so the same group opens again after it was closed. */
  nonce: number;
}

export type ProblemTarget =
  | { kind: "group"; group: ThemeSettingsGroup; fieldId: string | null }
  | { kind: "part"; part: "announcement" | "header" | "footer" | "page"; fieldId: string | null }
  | { kind: "theme" };

const ROLES = Object.keys(COLOR_FIELD_IDS) as ColorRole[];

/** The editor target of a held-back theme part (`tokens`, `brand`, `block:…`, `app:…`, `homeMode`). */
export function themeProblemTarget(theme: StorefrontThemeDocument, part: string): ProblemTarget {
  if (part === "tokens") {
    const bad = ROLES.find((role) => !isStorefrontThemeHexColor(theme.tokens.colors[COLOR_ROLE_TOKEN[role]] ?? ""));
    const role = bad ?? themeContrastProblems(theme)[0]?.role;
    return { kind: "group", group: "colors", fieldId: role ? COLOR_FIELD_IDS[role] : null };
  }
  if (part === "brand") return { kind: "group", group: "logo", fieldId: THEME_FIELD_IDS.logo };
  if (part === "block:card" || part === "app:productCard") return { kind: "group", group: "productCards", fieldId: null };
  if (part === "app:header") return { kind: "part", part: "header", fieldId: null };
  if (part === "app:footer") return { kind: "part", part: "footer", fieldId: null };
  if (part === "block:topBar") return { kind: "part", part: "announcement", fieldId: null };
  if (part === "homeMode") return { kind: "part", part: "page", fieldId: THEME_FIELD_IDS.homeProduct };
  return { kind: "theme" };
}

/** The request the Theme settings panel reads (a group opens when it is named). */
export const ThemeRevealContext = createContext<ThemeRevealRequest | null>(null);
export const useThemeReveal = () => useContext(ThemeRevealContext);
