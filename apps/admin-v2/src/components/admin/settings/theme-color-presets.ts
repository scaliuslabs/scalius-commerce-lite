import {
  DEFAULT_STOREFRONT_THEME_COLORS,
  STOREFRONT_THEME_COLOR_PALETTES,
} from "@scalius/shared/storefront-theme";

export const THEME_ACTION_CONTRAST_PAIRS = [
  { background: "primary", foreground: "primary-foreground" },
  { background: "secondary", foreground: "secondary-foreground" },
  { background: "accent", foreground: "accent-foreground" },
  { background: "destructive", foreground: "destructive-foreground" },
] as const;

export const THEME_SURFACE_CONTRAST_PAIRS = [
  { background: "background", foreground: "foreground" },
  { background: "card", foreground: "card-foreground" },
  { background: "muted", foreground: "muted-foreground" },
] as const;

export const THEME_CONTRAST_PAIRS = [
  ...THEME_ACTION_CONTRAST_PAIRS,
  ...THEME_SURFACE_CONTRAST_PAIRS,
] as const;

/** Shared with the buyer storefront; this is no longer an admin-only guess. */
export const DEFAULT_THEME_COLORS = DEFAULT_STOREFRONT_THEME_COLORS;
export const THEME_COLOR_PALETTES = STOREFRONT_THEME_COLOR_PALETTES;
