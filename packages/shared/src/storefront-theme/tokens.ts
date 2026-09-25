// Tokens: the shared grammar. Every block reads them and none carries its own
// radius, font size or colour, so any mix of block variants stays coherent
// (storefront study, SYNTHESIS.md section 3 and mix rule 1).
import { z } from "zod";
import {
  STOREFRONT_THEME_COLOR_KEYS,
  storefrontHeaderToneColors,
  type StorefrontThemeColorKey,
  type StorefrontThemeColors,
} from "./contrast";

/**
 * Curated type pairings: heading and body families, weights, tracking and
 * leading chosen together (a free font picker makes weak pairs). Families
 * are Google Fonts, self-hosted by the storefront; see STOREFRONT_FONTS.
 */
export const STOREFRONT_TYPE_PAIRINGS = [
  "retail",
  "market",
  "editorial",
  "fresh",
  "beauty",
  "heritage",
  "tech",
] as const;
/** h1 and section-title size and weight relative to body text. */
export const STOREFRONT_TYPE_SCALES = ["flat", "retail", "display"] as const;
export const STOREFRONT_HEADING_CASES = ["sentence", "uppercase"] as const;
/**
 * How much fits on screen. Grids are fluid (auto-fill columns with a minimum
 * card width that steps up with the grid's own container width); density
 * sets that minimum, the gaps, control height and the type/spacing scale.
 */
export const STOREFRONT_DENSITIES = ["dense", "compact", "comfortable", "airy"] as const;
export const STOREFRONT_THEME_RADII = ["square", "subtle", "rounded", "soft"] as const;
/** Button corners: square, the theme radius, or fully rounded (pill). */
export const STOREFRONT_THEME_BUTTON_SHAPES = ["square", "radius", "pill"] as const;
/** flat: no border or shadow; hairline: a 1px border; raised: a soft shadow (never both a border and a shadow). */
export const STOREFRONT_THEME_SURFACES = ["flat", "hairline", "raised"] as const;
export const STOREFRONT_IMAGE_RATIOS = ["square", "portrait", "landscape"] as const;
/** contain: catalogue photos on white; cover: lifestyle photos. */
export const STOREFRONT_IMAGE_FITS = ["contain", "cover"] as const;
export const STOREFRONT_HEADER_TONES = ["light", "dark", "brand"] as const;
/** Content width cap in px (`full` caps at 2560px for image sizing). */
export const STOREFRONT_CONTAINERS = ["1200", "1290", "1360", "1440", "full"] as const;

export type StorefrontTypePairing = (typeof STOREFRONT_TYPE_PAIRINGS)[number];
export type StorefrontTypeScale = (typeof STOREFRONT_TYPE_SCALES)[number];
export type StorefrontHeadingCase = (typeof STOREFRONT_HEADING_CASES)[number];
export type StorefrontDensity = (typeof STOREFRONT_DENSITIES)[number];
export type StorefrontThemeRadius = (typeof STOREFRONT_THEME_RADII)[number];
export type StorefrontThemeButtonShape = (typeof STOREFRONT_THEME_BUTTON_SHAPES)[number];
export type StorefrontThemeSurface = (typeof STOREFRONT_THEME_SURFACES)[number];
export type StorefrontImageRatio = (typeof STOREFRONT_IMAGE_RATIOS)[number];
export type StorefrontImageFit = (typeof STOREFRONT_IMAGE_FITS)[number];
export type StorefrontHeaderTone = (typeof STOREFRONT_HEADER_TONES)[number];
export type StorefrontContainer = (typeof STOREFRONT_CONTAINERS)[number];

// ─── Density ──────────────────────────────────────────────────────────────

/** Fluid product grid facts: see apps/storefront/src/lib/product-card-layout.ts. */
export interface StorefrontGridSpec {
  /** Minimum card width for a grid container narrower than 36rem, 36-60rem and wider. */
  cardMin: { phone: string; tablet: string; desktop: string };
  /** Grid gap at phone and desktop container widths. */
  gap: { phone: string; desktop: string };
}

export interface StorefrontDensitySpec extends StorefrontGridSpec {
  /** Multiplies the fluid type and spacing scale (with the pairing's own factor). */
  scale: string;
  /** Button and input height; phones keep 44px touch targets whatever this is. */
  control: string;
  /** Space between homepage sections. */
  section: { phone: string; desktop: string };
}

/**
 * Measured steps (SYNTHESIS.md section 3). Card minimums are grid minimums,
 * not the measured card widths: an auto-fill grid stretches cards above the
 * minimum, and two cards must fit a 360px phone. Body text never drops
 * below 14px on phones (Bangla legibility), so `dense` shares compact's
 * type scale and differs in gaps, card minimums and control height.
 */
export const STOREFRONT_DENSITY_SPECS = {
  // Daraz, Star Tech: hairline gaps, many columns.
  dense: {
    cardMin: { phone: "9.25rem", tablet: "10.5rem", desktop: "11.75rem" },
    // 12px on computers: the top of the measured 0-12px, and the smallest
    // gap that keeps columns from dropping when the page gutter grows at 1024px.
    gap: { phone: "0.0625rem", desktop: "0.75rem" },
    scale: "0.92",
    control: "2.25rem",
    section: { phone: "1.5rem", desktop: "2rem" },
  },
  // Game Ghor, Fabrilife, Amazon.
  compact: {
    cardMin: { phone: "9.25rem", tablet: "11rem", desktop: "12.5rem" },
    gap: { phone: "0.5rem", desktop: "1rem" },
    scale: "0.92",
    control: "2.5rem",
    section: { phone: "2rem", desktop: "3rem" },
  },
  // Apple Gadgets, Target.
  comfortable: {
    cardMin: { phone: "9.75rem", tablet: "13rem", desktop: "15rem" },
    gap: { phone: "0.75rem", desktop: "1.5rem" },
    scale: "1",
    control: "2.75rem",
    section: { phone: "2.5rem", desktop: "4rem" },
  },
  // Dawn, Aarong: small gaps between cards, large space between sections.
  airy: {
    cardMin: { phone: "9.75rem", tablet: "13rem", desktop: "16.25rem" },
    gap: { phone: "0.25rem", desktop: "0.5rem" },
    scale: "1",
    control: "2.9375rem",
    section: { phone: "4rem", desktop: "6rem" },
  },
} as const satisfies Record<StorefrontDensity, StorefrontDensitySpec>;

/** h1 and section titles relative to body text (Star Tech 22/15; Target 32/16; Dawn 40/16). */
export const STOREFRONT_TYPE_SCALE_SPECS = {
  flat: { h1: "1.43", section: "1.5", h1Weight: 400, sectionWeight: 700 },
  retail: { h1: "1.8", section: "2", h1Weight: 700, sectionWeight: 700 },
  display: { h1: "2.5", section: "3.2", h1Weight: 400, sectionWeight: 400 },
} as const satisfies Record<StorefrontTypeScale, { h1: string; section: string; h1Weight: number; sectionWeight: number }>;

const RADIUS_TOKENS = { square: "0rem", subtle: "0.4rem", rounded: "0.75rem", soft: "1.25rem" } as const satisfies Record<StorefrontThemeRadius, string>;
const CONTAINER_TOKENS = {
  "1200": "75rem",
  "1290": "80.625rem",
  "1360": "85rem",
  "1440": "90rem",
  full: "160rem",
} as const satisfies Record<StorefrontContainer, string>;
const IMAGE_RATIO_TOKENS = { square: "1 / 1", portrait: "3 / 4", landscape: "4 / 3" } as const satisfies Record<StorefrontImageRatio, string>;
/** The radius tokens in CSS px (at a 16px root), for looks that need a number. */
export const STOREFRONT_RADIUS_PX = { square: 0, subtle: 6.4, rounded: 12, soft: 20 } as const satisfies Record<StorefrontThemeRadius, number>;
/** The photo ratio tokens as width / height. */
export const STOREFRONT_IMAGE_RATIO_VALUES = { square: 1, portrait: 0.75, landscape: 4 / 3 } as const satisfies Record<StorefrontImageRatio, number>;

/** The ratio token nearest a width / height (portrait below 0.9, landscape above 1.15). */
export function storefrontNearestImageRatio(ratio: number): StorefrontImageRatio {
  if (ratio < 0.9) return "portrait";
  if (ratio > 1.15) return "landscape";
  return "square";
}

// ─── Fonts ────────────────────────────────────────────────────────────────

/**
 * Self-hosted font families. `fallback` is metric-matched where the family
 * ships a `* Fallback` face (size-adjust/ascent overrides, so swapping in
 * the web font never shifts layout) and otherwise a curated system stack.
 * `bangla` names the Bengali family that follows it in the stack: Latin
 * faces carry a Latin unicode-range, so Bangla text falls through to it.
 */
export const STOREFRONT_FONTS = {
  inter: { family: "Inter", fallback: '"Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  "instrument-serif": { family: "Instrument Serif", fallback: '"Instrument Serif Fallback", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' },
  "dm-serif-display": { family: "DM Serif Display", fallback: '"DM Serif Display Fallback", Georgia, "Times New Roman", serif' },
  "dm-sans": { family: "DM Sans", fallback: '"DM Sans Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  "nunito-sans": { family: "Nunito Sans", fallback: '"Nunito Sans Fallback", "Avenir Next", Avenir, ui-sans-serif, system-ui, sans-serif' },
  "cormorant-garamond": { family: "Cormorant Garamond", fallback: '"Cormorant Garamond Fallback", Garamond, "Iowan Old Style", Georgia, serif' },
} as const;
export type StorefrontFontKey = keyof typeof STOREFRONT_FONTS;

export const STOREFRONT_BANGLA_FONTS = {
  sans: { family: "Noto Sans Bengali", fallback: '"Noto Sans Bengali UI", Vrinda, sans-serif' },
  // Hind Siliguri: compact, sturdy Bangla for dense marketplace/grocery UI.
  hind: { family: "Hind Siliguri", fallback: '"Noto Sans Bengali", "Noto Sans Bengali UI", Vrinda, sans-serif' },
  serif: { family: "Noto Serif Bengali", fallback: '"Noto Sans Bengali", Vrinda, serif' },
} as const;

/**
 * What each pairing sets. Tracking is in em; leading is unitless; `scale`
 * multiplies the fluid type scale (with the density's own factor).
 */
export const STOREFRONT_TYPE_PAIRING_SPECS = {
  // Shopify Horizon/Dawn, Allbirds: one confident grotesque, tight headings.
  retail: { heading: "inter", body: "inter", bangla: "sans", headingWeight: 650, headingTracking: "-0.02em", headingLeading: "1.15", bodyLeading: "1.6", labelTracking: "0.06em", scale: "1" },
  // Amazon/Daraz/Target: compact, bold, scannable.
  market: { heading: "inter", body: "inter", bangla: "hind", headingWeight: 700, headingTracking: "-0.01em", headingLeading: "1.2", bodyLeading: "1.5", labelTracking: "0.04em", scale: "0.96" },
  // COS/Aesop/Ssense: a quiet editorial serif over a neutral grotesque.
  editorial: { heading: "instrument-serif", body: "inter", bangla: "serif", headingWeight: 400, headingTracking: "-0.01em", headingLeading: "1.08", bodyLeading: "1.65", labelTracking: "0.14em", scale: "1.04" },
  // Instacart/Ocado/Chaldal: friendly, rounded, very legible at small sizes.
  fresh: { heading: "nunito-sans", body: "nunito-sans", bangla: "hind", headingWeight: 800, headingTracking: "-0.015em", headingLeading: "1.15", bodyLeading: "1.55", labelTracking: "0.05em", scale: "1" },
  // Glossier/Sephora: soft display serif with a clean geometric sans.
  beauty: { heading: "dm-serif-display", body: "dm-sans", bangla: "sans", headingWeight: 400, headingTracking: "-0.005em", headingLeading: "1.1", bodyLeading: "1.6", labelTracking: "0.1em", scale: "1.02" },
  // Aarong/Fabindia/Anthropologie: crafted Garamond with Bengali serif.
  heritage: { heading: "cormorant-garamond", body: "inter", bangla: "serif", headingWeight: 600, headingTracking: "0em", headingLeading: "1.1", bodyLeading: "1.7", labelTracking: "0.12em", scale: "1.05" },
  // Apple/Nothing/Linear: precise grotesque, tight tracking on dark.
  tech: { heading: "inter", body: "inter", bangla: "sans", headingWeight: 600, headingTracking: "-0.03em", headingLeading: "1.1", bodyLeading: "1.6", labelTracking: "0.08em", scale: "1" },
} as const satisfies Record<StorefrontTypePairing, {
  heading: StorefrontFontKey;
  body: StorefrontFontKey;
  bangla: keyof typeof STOREFRONT_BANGLA_FONTS;
  headingWeight: number;
  headingTracking: string;
  headingLeading: string;
  bodyLeading: string;
  labelTracking: string;
  scale: string;
}>;

/** The font families a pairing renders (for self-hosted @font-face). */
export function storefrontPairingFonts(pairing: StorefrontTypePairing): {
  fonts: StorefrontFontKey[];
  bangla: keyof typeof STOREFRONT_BANGLA_FONTS;
  heading: StorefrontFontKey;
} {
  const spec = STOREFRONT_TYPE_PAIRING_SPECS[pairing];
  return { fonts: [...new Set<StorefrontFontKey>([spec.heading, spec.body])], bangla: spec.bangla, heading: spec.heading };
}

function fontStack(font: StorefrontFontKey, bangla: keyof typeof STOREFRONT_BANGLA_FONTS): string {
  const latin = STOREFRONT_FONTS[font];
  const bengali = STOREFRONT_BANGLA_FONTS[bangla];
  return `"${latin.family}", "${bengali.family}", ${latin.fallback}, ${bengali.fallback}`;
}

// ─── Palettes ─────────────────────────────────────────────────────────────

type Palette = Readonly<StorefrontThemeColors>;

function palette(colors: Omit<Palette, "popover" | "popover-foreground" | "ring"> & Partial<Palette>): Palette {
  return {
    popover: colors.card,
    "popover-foreground": colors["card-foreground"],
    ring: colors.primary,
    ...colors,
  } as Palette;
}

/**
 * Curated palettes: ink, a single restrained brand colour, neutrals tinted
 * toward the palette's hue (never raw grey on a warm page), surfaces, and
 * semantic tones. Templates choose one and never hard-code colour. Each
 * passes every AA pair of every block and the helper-vs-error rule
 * (tested). Rationale per palette: storefront-theme.md.
 */
export const STOREFRONT_THEME_PALETTES = {
  // Horizon/Dawn, Allbirds, Game Ghor: a white page (every reference of the
  // templates on this palette is white), charcoal ink, charcoal buttons;
  // sand neutrals carry the warmth, the brand colour stays quiet.
  retail: palette({
    background: "#ffffff", foreground: "#1d1c1a", card: "#ffffff", "card-foreground": "#1d1c1a",
    primary: "#1d1c1a", "primary-foreground": "#fbfaf7",
    secondary: "#f1eee8", "secondary-foreground": "#1d1c1a",
    muted: "#f1eee8", "muted-foreground": "#5d5850",
    accent: "#e9e3d8", "accent-foreground": "#1d1c1a",
    destructive: "#b42318", "destructive-foreground": "#ffffff",
    border: "#e5e0d6", input: "#d3ccbf", ring: "#1d1c1a",
  }),
  // Amazon/Daraz/Target: bright white, near-black ink, cool neutral panels
  // for density, one saturated orange reserved for buying actions.
  marketplace: palette({
    background: "#ffffff", foreground: "#0f1111", card: "#ffffff", "card-foreground": "#0f1111",
    primary: "#c2410c", "primary-foreground": "#ffffff",
    secondary: "#f2f4f5", "secondary-foreground": "#0f1111",
    muted: "#f2f4f5", "muted-foreground": "#565959",
    accent: "#fff1e6", "accent-foreground": "#7a2e0e",
    destructive: "#b12704", "destructive-foreground": "#ffffff",
    border: "#e3e6e6", input: "#c7cccc", ring: "#c2410c",
  }),
  // COS/Aesop/Ssense: linen page, espresso ink, no colour at all; hierarchy
  // comes from type and space.
  boutique: palette({
    background: "#f6f4ef", foreground: "#242220", card: "#f6f4ef", "card-foreground": "#242220",
    primary: "#242220", "primary-foreground": "#f6f4ef",
    secondary: "#ebe7df", "secondary-foreground": "#242220",
    muted: "#ebe7df", "muted-foreground": "#5a554d",
    accent: "#e3ddd2", "accent-foreground": "#242220",
    destructive: "#9b1c1c", "destructive-foreground": "#ffffff",
    border: "#d9d3c7", input: "#c9c1b3", ring: "#242220",
  }),
  // Instacart/Ocado/Chaldal: clean white with a fresh leaf green for buying,
  // soft green-tinted panels for categories and delivery facts.
  fresh: palette({
    background: "#ffffff", foreground: "#15231b", card: "#ffffff", "card-foreground": "#15231b",
    primary: "#0b7a3e", "primary-foreground": "#ffffff",
    secondary: "#f1f6f1", "secondary-foreground": "#15231b",
    muted: "#f1f6f1", "muted-foreground": "#4b5a51",
    accent: "#e3f4e6", "accent-foreground": "#0b4f2a",
    destructive: "#c0262d", "destructive-foreground": "#ffffff",
    border: "#dde8de", input: "#c6d6c8", ring: "#0b7a3e",
  }),
  // Glossier/Sephora: black type and black pill buttons on white, a blush
  // accent used sparingly on surfaces, never on text.
  beauty: palette({
    background: "#ffffff", foreground: "#1a1718", card: "#ffffff", "card-foreground": "#1a1718",
    primary: "#1a1718", "primary-foreground": "#ffffff",
    secondary: "#fbf1f0", "secondary-foreground": "#1a1718",
    muted: "#fbf4f3", "muted-foreground": "#625a5b",
    accent: "#f8e1e1", "accent-foreground": "#5c1f2a",
    destructive: "#b4232c", "destructive-foreground": "#ffffff",
    border: "#f0e2e1", input: "#e2cfcd", ring: "#1a1718",
  }),
  // Aarong/Fabindia/Anthropologie: hand-made paper, umber ink and a madder
  // terracotta for actions; jute-tinted neutrals.
  heritage: palette({
    background: "#faf6ef", foreground: "#2a2018", card: "#fffdf8", "card-foreground": "#2a2018",
    primary: "#8a3b1e", "primary-foreground": "#fffdf8",
    secondary: "#f2eadd", "secondary-foreground": "#2a2018",
    muted: "#f2eadd", "muted-foreground": "#665646",
    accent: "#ecdfc9", "accent-foreground": "#4a2c14",
    destructive: "#a3191b", "destructive-foreground": "#ffffff",
    border: "#e2d5bf", input: "#d2c2a6", ring: "#8a3b1e",
  }),
  // Apple/Nothing/Linear: layered near-blacks (page, card, panel), white ink
  // and white buttons; one soft zinc for secondary text.
  midnight: palette({
    background: "#0a0a0b", foreground: "#f4f4f5", card: "#141416", "card-foreground": "#f4f4f5",
    primary: "#f4f4f5", "primary-foreground": "#0a0a0b",
    secondary: "#1c1c1f", "secondary-foreground": "#f4f4f5",
    muted: "#1c1c1f", "muted-foreground": "#a8a8b0",
    accent: "#232327", "accent-foreground": "#f4f4f5",
    // Error text sits on the dark page, so the red must be light.
    destructive: "#f87171", "destructive-foreground": "#0a0a0b",
    border: "#27272b", input: "#34343a", ring: "#d4d4d8",
  }),
} as const satisfies Record<string, Palette>;

export type StorefrontThemePaletteKey = keyof typeof STOREFRONT_THEME_PALETTES;
export const STOREFRONT_THEME_PALETTE_KEYS = Object.keys(STOREFRONT_THEME_PALETTES) as StorefrontThemePaletteKey[];

// ─── Schema ───────────────────────────────────────────────────────────────

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, "Use a #rrggbb colour.");

export const storefrontThemeTokensSchema = z.object({
  colors: z.object(
    Object.fromEntries(STOREFRONT_THEME_COLOR_KEYS.map((key) => [key, hexColorSchema])) as Record<
      StorefrontThemeColorKey,
      typeof hexColorSchema
    >,
  ).strict(),
  typography: z.enum(STOREFRONT_TYPE_PAIRINGS),
  typeScale: z.enum(STOREFRONT_TYPE_SCALES),
  headingCase: z.enum(STOREFRONT_HEADING_CASES),
  density: z.enum(STOREFRONT_DENSITIES),
  radius: z.enum(STOREFRONT_THEME_RADII),
  buttonShape: z.enum(STOREFRONT_THEME_BUTTON_SHAPES),
  surface: z.enum(STOREFRONT_THEME_SURFACES),
  imageRatio: z.enum(STOREFRONT_IMAGE_RATIOS),
  imageFit: z.enum(STOREFRONT_IMAGE_FITS),
  headerTone: z.enum(STOREFRONT_HEADER_TONES),
  container: z.enum(STOREFRONT_CONTAINERS),
}).strict();

export type StorefrontThemeTokens = z.infer<typeof storefrontThemeTokensSchema>;

// ─── CSS ──────────────────────────────────────────────────────────────────

/** CSS custom properties for the tokens: only constants and validated hex colours. */
export function buildStorefrontTokenCss(tokens: StorefrontThemeTokens): Record<string, string> {
  const density = STOREFRONT_DENSITY_SPECS[tokens.density];
  const type = STOREFRONT_TYPE_PAIRING_SPECS[tokens.typography];
  const scale = STOREFRONT_TYPE_SCALE_SPECS[tokens.typeScale];
  const header = storefrontHeaderToneColors(tokens.headerTone, tokens.colors);
  return {
    ...tokens.colors,
    "theme-font-heading": fontStack(type.heading, type.bangla),
    "theme-font-body": fontStack(type.body, type.bangla),
    "theme-heading-weight": String(type.headingWeight),
    "theme-heading-tracking": type.headingTracking,
    "theme-heading-leading": type.headingLeading,
    "theme-body-leading": type.bodyLeading,
    "theme-label-tracking": type.labelTracking,
    "theme-type-scale": String(Number(density.scale) * Number(type.scale)),
    "theme-h1-ratio": scale.h1,
    "theme-section-ratio": scale.section,
    "theme-h1-weight": String(scale.h1Weight),
    "theme-section-weight": String(scale.sectionWeight),
    "theme-heading-transform": tokens.headingCase === "uppercase" ? "uppercase" : "none",
    radius: RADIUS_TOKENS[tokens.radius],
    "theme-button-radius": tokens.buttonShape === "pill"
      ? "9999px"
      : tokens.buttonShape === "square" ? "0rem" : RADIUS_TOKENS[tokens.radius],
    "theme-density-scale": density.scale,
    "theme-control-height": density.control,
    "theme-card-min-phone": density.cardMin.phone,
    "theme-card-min-tablet": density.cardMin.tablet,
    "theme-card-min-desktop": density.cardMin.desktop,
    "theme-grid-gap-phone": density.gap.phone,
    "theme-grid-gap-desktop": density.gap.desktop,
    "theme-section-gap-phone": density.section.phone,
    "theme-section-gap-desktop": density.section.desktop,
    "theme-image-ratio": IMAGE_RATIO_TOKENS[tokens.imageRatio],
    "theme-image-fit": tokens.imageFit,
    "theme-header-background": tokens.colors[header.background],
    "theme-header-foreground": tokens.colors[header.foreground],
    "theme-container-width": CONTAINER_TOKENS[tokens.container],
  };
}
