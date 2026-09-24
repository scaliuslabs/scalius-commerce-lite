// Colour maths and the readable-text rules every theme document meets.
// Pairs name colour tokens, or the header surface the `headerTone` token
// picks, so a block that paints text on a tinted strip or a dark header
// declares exactly which pair it renders (blocks.ts `contrastPairs`).

/** Every colour token the storefront CSS reads; a document sets all of them. */
export const STOREFRONT_THEME_COLOR_KEYS = [
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
] as const;

export type StorefrontThemeColorKey = (typeof STOREFRONT_THEME_COLOR_KEYS)[number];
export type StorefrontThemeColors = Record<StorefrontThemeColorKey, string>;

/**
 * Header surfaces: `headerTone` decides which colour tokens they are
 * (tokens.ts `storefrontHeaderToneColors`). Blocks painted in the header's
 * colours (a dark header row, a dark support footer) use these roles.
 */
export type StorefrontThemeHeaderRole = "header-background" | "header-foreground";
export type StorefrontThemeContrastRole = StorefrontThemeColorKey | StorefrontThemeHeaderRole;
export type StorefrontThemeContrastPair = readonly [text: StorefrontThemeContrastRole, surface: StorefrontThemeContrastRole];

/**
 * Text/background pairs every storefront page renders. Every document must
 * meet WCAG 1.4.3 AA (4.5:1) on each, so no colour choice can ship
 * unreadable text. Blocks add their own pairs on top (blocks.ts).
 */
export const STOREFRONT_THEME_TEXT_PAIRS = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["primary", "background"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["destructive", "background"],
  ["header-foreground", "header-background"],
] as const satisfies ReadonlyArray<StorefrontThemeContrastPair>;

export const STOREFRONT_THEME_MIN_CONTRAST = 4.5;

/**
 * Helper text is not an error. Secondary ("muted") text stays near-neutral
 * (Lab chroma at most this) so a brand accent never reads as a warning...
 */
export const STOREFRONT_THEME_MAX_MUTED_CHROMA = 25;
/** ...and stays clearly apart from the error colour (CIE76 colour distance). */
export const STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE = 40;

export function isStorefrontThemeHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value);
}

function linearChannels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function storefrontThemeLuminance(hex: string): number {
  const [r, g, b] = linearChannels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function storefrontThemeContrast(foreground: string, background: string): number {
  const [light, dark] = [storefrontThemeLuminance(foreground), storefrontThemeLuminance(background)]
    .sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function lab(hex: string): [number, number, number] {
  const [r, g, b] = linearChannels(hex);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Lab chroma of a `#rrggbb` colour (0 is grey). */
export function storefrontThemeChroma(hex: string): number {
  const [, a, b] = lab(hex);
  return Math.hypot(a, b);
}

/** CIE76 colour distance between two `#rrggbb` colours. */
export function storefrontThemeColorDistance(first: string, second: string): number {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export type StorefrontThemeHeaderTone = "light" | "dark" | "brand";

/**
 * The colour tokens behind the header surfaces. `dark` takes the darker of
 * ink and page (so a dark palette's header stays dark), `brand` the action
 * colour. Each is an existing AA pair, so a tone never adds a failure.
 */
export function storefrontHeaderToneColors(
  tone: StorefrontThemeHeaderTone,
  colors: StorefrontThemeColors,
): { background: StorefrontThemeColorKey; foreground: StorefrontThemeColorKey } {
  if (tone === "brand") return { background: "primary", foreground: "primary-foreground" };
  if (tone === "light") return { background: "background", foreground: "foreground" };
  return storefrontThemeLuminance(colors.foreground) < storefrontThemeLuminance(colors.background)
    ? { background: "foreground", foreground: "background" }
    : { background: "background", foreground: "foreground" };
}

export function resolveStorefrontContrastRole(
  role: StorefrontThemeContrastRole,
  colors: StorefrontThemeColors,
  tone: StorefrontThemeHeaderTone,
): string {
  if (role === "header-background") return colors[storefrontHeaderToneColors(tone, colors).background];
  if (role === "header-foreground") return colors[storefrontHeaderToneColors(tone, colors).foreground];
  return colors[role];
}

export interface StorefrontThemeContrastProblem {
  text: StorefrontThemeContrastRole;
  surface: StorefrontThemeContrastRole;
  ratio: number;
}

/** Pairs below AA for a colour map (empty when every pair passes). */
export function listStorefrontThemeContrastProblems(
  colors: StorefrontThemeColors,
  pairs: ReadonlyArray<StorefrontThemeContrastPair> = STOREFRONT_THEME_TEXT_PAIRS,
  tone: StorefrontThemeHeaderTone = "light",
): StorefrontThemeContrastProblem[] {
  const seen = new Set<string>();
  return pairs.flatMap(([text, surface]) => {
    const key = `${text}/${surface}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const ratio = storefrontThemeContrast(
      resolveStorefrontContrastRole(text, colors, tone),
      resolveStorefrontContrastRole(surface, colors, tone),
    );
    return ratio < STOREFRONT_THEME_MIN_CONTRAST ? [{ text, surface, ratio }] : [];
  });
}

/** Semantic-role problems: helper text that is tinted or looks like an error. */
export function listStorefrontThemeSemanticColorProblems(colors: StorefrontThemeColors): string[] {
  const problems: string[] = [];
  const muted = colors["muted-foreground"];
  if (storefrontThemeChroma(muted) > STOREFRONT_THEME_MAX_MUTED_CHROMA) {
    problems.push("Secondary text must be a near-neutral colour, not a brand accent.");
  }
  if (storefrontThemeColorDistance(muted, colors.destructive) < STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE) {
    problems.push("Secondary text looks too much like error text.");
  }
  return problems;
}
