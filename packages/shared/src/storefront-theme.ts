const STOREFRONT_THEME_COLOR_KEYS = new Set([
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
]);

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION_RE =
  /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lch|lab)\(\s*[-+0-9.%\s,/]+\)$/i;
const STYLE_BREAKOUT_CHARS = new Set([";", "{", "}", "<", ">", "\\"]);
const UNSAFE_TOKEN_RE = /(?:\/\*|\*\/|@import|expression\s*\(|url\s*\(|javascript\s*:)/i;
const NAMED_COLORS = new Set(["transparent", "currentcolor", "black", "white"]);

export const STOREFRONT_THEME_HEADING_FONTS = [
  "system",
  "modern",
  "editorial",
] as const;
export const STOREFRONT_THEME_BODY_FONTS = [
  "system",
  "modern",
  "humanist",
] as const;
export const STOREFRONT_THEME_TYPE_SCALES = [
  "compact",
  "standard",
  "generous",
] as const;
export const STOREFRONT_THEME_CORNER_STYLES = [
  "square",
  "subtle",
  "rounded",
] as const;
export const STOREFRONT_THEME_DENSITIES = [
  "compact",
  "comfortable",
  "airy",
] as const;
export const STOREFRONT_THEME_CONTAINER_WIDTHS = [
  "focused",
  "standard",
  "wide",
] as const;
export const STOREFRONT_THEME_BUTTON_STYLES = [
  "solid",
  "soft",
  "outline",
] as const;
export const STOREFRONT_THEME_INPUT_STYLES = ["outlined", "filled"] as const;
export const STOREFRONT_THEME_CARD_STYLES = [
  "bordered",
  "elevated",
  "flat",
] as const;

export type StorefrontThemeHeadingFont =
  (typeof STOREFRONT_THEME_HEADING_FONTS)[number];
export type StorefrontThemeBodyFont =
  (typeof STOREFRONT_THEME_BODY_FONTS)[number];
export type StorefrontThemeTypeScale =
  (typeof STOREFRONT_THEME_TYPE_SCALES)[number];
export type StorefrontThemeCornerStyle =
  (typeof STOREFRONT_THEME_CORNER_STYLES)[number];
export type StorefrontThemeDensity =
  (typeof STOREFRONT_THEME_DENSITIES)[number];
export type StorefrontThemeContainerWidth =
  (typeof STOREFRONT_THEME_CONTAINER_WIDTHS)[number];
export type StorefrontThemeButtonStyle =
  (typeof STOREFRONT_THEME_BUTTON_STYLES)[number];
export type StorefrontThemeInputStyle =
  (typeof STOREFRONT_THEME_INPUT_STYLES)[number];
export type StorefrontThemeCardStyle =
  (typeof STOREFRONT_THEME_CARD_STYLES)[number];

export interface StorefrontThemeSettings {
  /** Explicit color overrides. Missing values use the shared storefront defaults. */
  colors: Record<string, string>;
  typography: {
    heading: StorefrontThemeHeadingFont;
    body: StorefrontThemeBodyFont;
    scale: StorefrontThemeTypeScale;
  };
  cornerStyle: StorefrontThemeCornerStyle;
  density: StorefrontThemeDensity;
  containerWidth: StorefrontThemeContainerWidth;
  components: {
    buttons: StorefrontThemeButtonStyle;
    inputs: StorefrontThemeInputStyle;
    cards: StorefrontThemeCardStyle;
  };
}

/**
 * These values mirror the buyer storefront before semantic theme settings.
 * Keeping them here makes an unedited or newly upgraded store visually stable.
 */
export const DEFAULT_STOREFRONT_THEME_SETTINGS: StorefrontThemeSettings = {
  colors: {},
  typography: {
    heading: "system",
    body: "system",
    scale: "standard",
  },
  cornerStyle: "subtle",
  density: "comfortable",
  containerWidth: "wide",
  components: {
    buttons: "solid",
    inputs: "outlined",
    cards: "bordered",
  },
};

export const DEFAULT_STOREFRONT_THEME_COLORS: Readonly<Record<string, string>> = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.21 0.006 285.885)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.21 0.006 285.885)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.21 0.006 285.885)",
  primary: "oklch(0.53 0.14 150)",
  "primary-foreground": "oklch(0.985 0 0)",
  secondary: "oklch(0.967 0.001 286.375)",
  "secondary-foreground": "oklch(0.274 0.006 286.033)",
  muted: "oklch(0.967 0.001 286.375)",
  "muted-foreground": "oklch(0.552 0.016 285.938)",
  accent: "oklch(0.967 0.001 286.375)",
  "accent-foreground": "oklch(0.21 0.006 285.885)",
  destructive: "oklch(0.577 0.245 27.325)",
  "destructive-foreground": "oklch(0.985 0 0)",
  border: "oklch(0.92 0.004 286.32)",
  input: "oklch(0.92 0.004 286.32)",
  ring: "oklch(0.53 0.14 150 / 0.5)",
  "chart-1": "oklch(0.646 0.222 41.116)",
  "chart-2": "oklch(0.6 0.118 184.704)",
  "chart-3": "oklch(0.398 0.07 227.392)",
  "chart-4": "oklch(0.828 0.189 84.429)",
  "chart-5": "oklch(0.769 0.188 70.08)",
};

export const STOREFRONT_THEME_COLOR_PALETTES: Readonly<
  Record<string, { label: string; colors: Readonly<Record<string, string>> }>
> = {
  Current: {
    label: "Store default",
    colors: DEFAULT_STOREFRONT_THEME_COLORS,
  },
  Zinc: {
    label: "Zinc",
    colors: {
      background: "#ffffff",
      foreground: "#09090b",
      card: "#ffffff",
      "card-foreground": "#09090b",
      popover: "#ffffff",
      "popover-foreground": "#09090b",
      primary: "#18181b",
      "primary-foreground": "#fafafa",
      secondary: "#f4f4f5",
      "secondary-foreground": "#18181b",
      muted: "#f4f4f5",
      "muted-foreground": "#52525b",
      accent: "#f4f4f5",
      "accent-foreground": "#18181b",
      destructive: "#dc2626",
      "destructive-foreground": "#ffffff",
      border: "#e4e4e7",
      input: "#e4e4e7",
      ring: "#09090b",
    },
  },
  Ocean: {
    label: "Ocean",
    colors: {
      background: "#ffffff",
      foreground: "#0f172a",
      card: "#ffffff",
      "card-foreground": "#0f172a",
      primary: "#1d4ed8",
      "primary-foreground": "#ffffff",
      secondary: "#e2e8f0",
      "secondary-foreground": "#0f172a",
      muted: "#f1f5f9",
      "muted-foreground": "#475569",
      accent: "#dbeafe",
      "accent-foreground": "#1e3a8a",
      destructive: "#b91c1c",
      "destructive-foreground": "#ffffff",
      border: "#cbd5e1",
      input: "#cbd5e1",
      ring: "#1d4ed8",
    },
  },
  Emerald: {
    label: "Emerald",
    colors: {
      background: "#ffffff",
      foreground: "#022c22",
      card: "#ffffff",
      "card-foreground": "#022c22",
      primary: "#047857",
      "primary-foreground": "#ffffff",
      secondary: "#d1fae5",
      "secondary-foreground": "#064e3b",
      muted: "#ecfdf5",
      "muted-foreground": "#065f46",
      accent: "#a7f3d0",
      "accent-foreground": "#064e3b",
      destructive: "#b91c1c",
      "destructive-foreground": "#ffffff",
      border: "#a7f3d0",
      input: "#a7f3d0",
      ring: "#047857",
    },
  },
  Rose: {
    label: "Rose",
    colors: {
      background: "#ffffff",
      foreground: "#4c0519",
      card: "#ffffff",
      "card-foreground": "#4c0519",
      primary: "#be123c",
      "primary-foreground": "#ffffff",
      secondary: "#ffe4e6",
      "secondary-foreground": "#881337",
      muted: "#fff1f2",
      "muted-foreground": "#9f1239",
      accent: "#fecdd3",
      "accent-foreground": "#881337",
      destructive: "#991b1b",
      "destructive-foreground": "#ffffff",
      border: "#fecdd3",
      input: "#fecdd3",
      ring: "#be123c",
    },
  },
  Midnight: {
    label: "Midnight",
    colors: {
      background: "#09090b",
      foreground: "#fafafa",
      card: "#18181b",
      "card-foreground": "#fafafa",
      popover: "#18181b",
      "popover-foreground": "#fafafa",
      primary: "#fafafa",
      "primary-foreground": "#18181b",
      secondary: "#27272a",
      "secondary-foreground": "#fafafa",
      muted: "#27272a",
      "muted-foreground": "#d4d4d8",
      accent: "#3f3f46",
      "accent-foreground": "#fafafa",
      destructive: "#991b1b",
      "destructive-foreground": "#fafafa",
      border: "#3f3f46",
      input: "#3f3f46",
      ring: "#d4d4d8",
    },
  },
};

const DOCUMENT_KEYS = new Set([
  "colors",
  "typography",
  "cornerStyle",
  "density",
  "containerWidth",
  "components",
]);
const TYPOGRAPHY_KEYS = new Set(["heading", "body", "scale"]);
const COMPONENT_KEYS = new Set(["buttons", "inputs", "cards"]);

const FONT_FAMILIES = {
  heading: {
    system:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    modern: '"Avenir Next", Avenir, "Segoe UI", ui-sans-serif, sans-serif',
    editorial: 'Georgia, "Times New Roman", ui-serif, serif',
  },
  body: {
    system:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    modern: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    humanist: 'Optima, Candara, "Noto Sans", ui-sans-serif, sans-serif',
  },
} as const;

const TYPE_SCALE_TOKENS = { compact: "0.95", standard: "1", generous: "1.06" } as const;
const RADIUS_TOKENS = { square: "0rem", subtle: "0.4rem", rounded: "0.75rem" } as const;
const DENSITY_TOKENS = { compact: "0.88", comfortable: "1", airy: "1.12" } as const;
const CONTAINER_TOKENS = { focused: "64rem", standard: "72rem", wide: "80rem" } as const;

export function isStorefrontThemeColorKey(key: string): boolean {
  return STOREFRONT_THEME_COLOR_KEYS.has(key);
}

export function isSafeStorefrontThemeColorValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) return false;
  if (hasControlOrStyleBreakoutChar(normalized)) return false;
  if (UNSAFE_TOKEN_RE.test(normalized)) return false;
  if (HEX_COLOR_RE.test(normalized)) return true;
  if (COLOR_FUNCTION_RE.test(normalized)) return true;
  if (NAMED_COLORS.has(normalized.toLowerCase())) return true;
  return isSafeStorefrontThemeVariableReference(normalized);
}

export function sanitizeStorefrontThemeColors(
  colors: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (!colors || typeof colors !== "object") return sanitized;

  for (const [key, value] of Object.entries(colors)) {
    if (!isStorefrontThemeColorKey(key)) continue;
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!isSafeStorefrontThemeColorValue(normalized)) continue;
    sanitized[key] = normalized;
  }

  return sanitized;
}

export function sanitizeStorefrontThemeSettings(
  value: unknown,
): StorefrontThemeSettings {
  const record = asRecord(value);
  const legacyColors = Object.keys(record).some((key) =>
    isStorefrontThemeColorKey(key),
  );
  const colors = sanitizeStorefrontThemeColors(
    legacyColors ? record : asRecord(record.colors),
  );
  const typography = asRecord(record.typography);
  const components = asRecord(record.components);

  return {
    colors,
    typography: {
      heading: enumValue(
        typography.heading,
        STOREFRONT_THEME_HEADING_FONTS,
        DEFAULT_STOREFRONT_THEME_SETTINGS.typography.heading,
      ),
      body: enumValue(
        typography.body,
        STOREFRONT_THEME_BODY_FONTS,
        DEFAULT_STOREFRONT_THEME_SETTINGS.typography.body,
      ),
      scale: enumValue(
        typography.scale,
        STOREFRONT_THEME_TYPE_SCALES,
        DEFAULT_STOREFRONT_THEME_SETTINGS.typography.scale,
      ),
    },
    cornerStyle: enumValue(
      record.cornerStyle,
      STOREFRONT_THEME_CORNER_STYLES,
      DEFAULT_STOREFRONT_THEME_SETTINGS.cornerStyle,
    ),
    density: enumValue(
      record.density,
      STOREFRONT_THEME_DENSITIES,
      DEFAULT_STOREFRONT_THEME_SETTINGS.density,
    ),
    containerWidth: enumValue(
      record.containerWidth,
      STOREFRONT_THEME_CONTAINER_WIDTHS,
      DEFAULT_STOREFRONT_THEME_SETTINGS.containerWidth,
    ),
    components: {
      buttons: enumValue(
        components.buttons,
        STOREFRONT_THEME_BUTTON_STYLES,
        DEFAULT_STOREFRONT_THEME_SETTINGS.components.buttons,
      ),
      inputs: enumValue(
        components.inputs,
        STOREFRONT_THEME_INPUT_STYLES,
        DEFAULT_STOREFRONT_THEME_SETTINGS.components.inputs,
      ),
      cards: enumValue(
        components.cards,
        STOREFRONT_THEME_CARD_STYLES,
        DEFAULT_STOREFRONT_THEME_SETTINGS.components.cards,
      ),
    },
  };
}

export function parseStorefrontThemeSettings(
  value: string | null | undefined,
): StorefrontThemeSettings {
  if (!value) return sanitizeStorefrontThemeSettings({});
  try {
    return sanitizeStorefrontThemeSettings(JSON.parse(value));
  } catch {
    return sanitizeStorefrontThemeSettings({});
  }
}

export function listInvalidStorefrontThemeColorEntries(
  colors: Record<string, unknown> | null | undefined,
): string[] {
  if (!colors || typeof colors !== "object") return [];

  const invalid: string[] = [];
  for (const [key, value] of Object.entries(colors)) {
    if (!isStorefrontThemeColorKey(key)) {
      invalid.push(key);
      continue;
    }
    if (typeof value !== "string" || !isSafeStorefrontThemeColorValue(value)) {
      invalid.push(key);
    }
  }
  return invalid;
}

export function listInvalidStorefrontThemeSettingsEntries(value: unknown): string[] {
  const record = asRecord(value);
  const invalid: string[] = [];

  for (const key of Object.keys(record)) {
    if (!DOCUMENT_KEYS.has(key)) invalid.push(key);
  }
  const colors = asRecord(record.colors);
  invalid.push(
    ...listInvalidStorefrontThemeColorEntries(colors).map((key) => `colors.${key}`),
  );

  const typography = asRecord(record.typography);
  for (const key of Object.keys(typography)) {
    if (!TYPOGRAPHY_KEYS.has(key)) invalid.push(`typography.${key}`);
  }
  if (!includes(STOREFRONT_THEME_HEADING_FONTS, typography.heading)) invalid.push("typography.heading");
  if (!includes(STOREFRONT_THEME_BODY_FONTS, typography.body)) invalid.push("typography.body");
  if (!includes(STOREFRONT_THEME_TYPE_SCALES, typography.scale)) invalid.push("typography.scale");
  if (!includes(STOREFRONT_THEME_CORNER_STYLES, record.cornerStyle)) invalid.push("cornerStyle");
  if (!includes(STOREFRONT_THEME_DENSITIES, record.density)) invalid.push("density");
  if (!includes(STOREFRONT_THEME_CONTAINER_WIDTHS, record.containerWidth)) invalid.push("containerWidth");

  const components = asRecord(record.components);
  for (const key of Object.keys(components)) {
    if (!COMPONENT_KEYS.has(key)) invalid.push(`components.${key}`);
  }
  if (!includes(STOREFRONT_THEME_BUTTON_STYLES, components.buttons)) invalid.push("components.buttons");
  if (!includes(STOREFRONT_THEME_INPUT_STYLES, components.inputs)) invalid.push("components.inputs");
  if (!includes(STOREFRONT_THEME_CARD_STYLES, components.cards)) invalid.push("components.cards");

  return [...new Set(invalid)];
}

/** Generates only constants and sanitized colors; merchant text never enters CSS. */
export function buildStorefrontThemeTokens(
  value: unknown,
): Record<string, string> {
  const theme = sanitizeStorefrontThemeSettings(value);
  return {
    ...theme.colors,
    "theme-font-heading": FONT_FAMILIES.heading[theme.typography.heading],
    "theme-font-body": FONT_FAMILIES.body[theme.typography.body],
    "theme-type-scale": TYPE_SCALE_TOKENS[theme.typography.scale],
    radius: RADIUS_TOKENS[theme.cornerStyle],
    "theme-density-scale": DENSITY_TOKENS[theme.density],
    "theme-container-width": CONTAINER_TOKENS[theme.containerWidth],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return includes(values, value) ? (value as Values[number]) : fallback;
}

function includes(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

function isSafeStorefrontThemeVariableReference(value: string): boolean {
  const match = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
  return Boolean(match?.[1] && STOREFRONT_THEME_COLOR_KEYS.has(match[1]));
}

function hasControlOrStyleBreakoutChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127 || STYLE_BREAKOUT_CHARS.has(char)) {
      return true;
    }
  }
  return false;
}
