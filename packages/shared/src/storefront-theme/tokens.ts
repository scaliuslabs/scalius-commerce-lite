// Tokens: the shared grammar. Every block reads them and none carries its own
// radius, font size or colour, so any mix of block variants stays coherent
// (storefront study, SYNTHESIS.md section 3 and mix rule 1).
import { z } from "zod";
import {
  STOREFRONT_THEME_COLOR_KEYS,
  STOREFRONT_THEME_MAX_MUTED_CHROMA,
  STOREFRONT_THEME_MIN_CONTRAST,
  STOREFRONT_THEME_MIN_FIELD_BORDER_CONTRAST,
  STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE,
  storefrontHeaderBands,
  storefrontHeaderToneColors,
  storefrontThemeChroma,
  storefrontThemeColorDistance,
  storefrontThemeContrast,
  storefrontThemeLuminance,
  storefrontThemeMix,
  type StorefrontThemeColorKey,
  type StorefrontThemeColors,
  type StorefrontThemeHeaderTone,
} from "./contrast";

/**
 * The rating colour: the amber every reference paints its stars and review
 * bars in. Decorative (a rating always carries its number in text), so it is
 * one constant token rather than a merchant colour.
 */
export const STOREFRONT_RATING_COLOR = "#f59e0b";

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
/**
 * The colours buyers see on every page: `light` the colours (`colors`),
 * `dark` the dark colours (`darkColors`), `system` whichever the buyer's
 * device asks for. The page's HTML is the same for every buyer: the choice
 * is made in the browser before the first paint.
 */
export const STOREFRONT_COLOR_SCHEMES = ["light", "dark", "system"] as const;
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
export type StorefrontColorScheme = (typeof STOREFRONT_COLOR_SCHEMES)[number];
/** The two colour sets of the tokens: the colours, and the dark colours. */
export type StorefrontThemeColorSet = "colors" | "darkColors";

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

// ─── Scales ("Scalius Base") ──────────────────────────────────────────────
// One system for every block: these scales are the only numbers components
// use (as Tailwind's own 4px steps and text sizes, or the CSS variables
// below). No component carries its own px radius, type size or colour.

/** The spacing scale in px: 4px steps. Tailwind's spacing unit is the same 4px. */
export const STOREFRONT_SPACE_SCALE = [4, 8, 12, 16, 24, 32, 48, 64, 96] as const;

/**
 * One modular type scale (about 1.2) in px, named like Tailwind's text
 * sizes. Body text is 16 (phones and Bangla never below 14). Product cards:
 * title 14/500 in two lines, price 16/600. Section titles 24, then 30 on
 * computers. Uppercase only for labels of three words or fewer.
 */
export const STOREFRONT_TYPE_STEPS = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36, "5xl": 48 } as const;

/** Page gutters in px: phone (below 640), tablet (640-1023) and computer. Header, sections, listing, product page and footer share them. */
export const STOREFRONT_GUTTERS = { phone: 16, tablet: 24, desktop: 32 } as const;

/** Inner padding of a card-like surface in px, phone and from 640 wide. */
export const STOREFRONT_SURFACE_PADDING = { phone: 12, desktop: 16 } as const;

/** Motion in ms: hovers and presses (fast), panels and fades (base). Reduced motion turns both off. */
export const STOREFRONT_MOTION_MS = { fast: 150, base: 250 } as const;

/**
 * The "in stock" dot. Decorative (the words always say it), so it is one
 * constant like the rating amber, never a merchant colour.
 */
export const STOREFRONT_SUCCESS_COLOR = "#15803d";

/**
 * Elevation, one rule for every card-like surface (product cards, facet
 * groups, buy-box panels, tiles): flat has no edge, hairline a 1px border,
 * raised a soft shadow. Never a border and a shadow together.
 */
export const STOREFRONT_ELEVATION = {
  flat: { border: "0 solid transparent", shadow: "none" },
  hairline: { border: "1px solid var(--border)", shadow: "none" },
  raised: {
    border: "0 solid transparent",
    shadow: "0 1px 2px color-mix(in oklab, var(--foreground) 6%, transparent), 0 8px 24px -12px color-mix(in oklab, var(--foreground) 18%, transparent)",
  },
} as const satisfies Record<StorefrontThemeSurface, { border: string; shadow: string }>;

/**
 * Density steps, on the spacing scale. Card minimums are grid minimums, not
 * card widths: an auto-fill grid stretches cards above the minimum, and two
 * cards must fit a 360px phone. Sections are 32px apart on phones; density
 * picks 48, 64 or 96 on computers. Body text never drops below 14px on
 * phones (Bangla legibility), so `dense` shares compact's type scale.
 */
export const STOREFRONT_DENSITY_SPECS = {
  dense: {
    cardMin: { phone: "9.25rem", tablet: "10.5rem", desktop: "11.75rem" },
    gap: { phone: "0.5rem", desktop: "0.75rem" },
    scale: "0.92",
    control: "2.25rem",
    section: { phone: "2rem", desktop: "3rem" },
  },
  compact: {
    cardMin: { phone: "9.25rem", tablet: "11rem", desktop: "12.5rem" },
    gap: { phone: "0.5rem", desktop: "1rem" },
    scale: "0.92",
    control: "2.5rem",
    section: { phone: "2rem", desktop: "3rem" },
  },
  comfortable: {
    cardMin: { phone: "9.75rem", tablet: "13rem", desktop: "15rem" },
    gap: { phone: "0.75rem", desktop: "1.5rem" },
    scale: "1",
    control: "2.75rem",
    section: { phone: "2rem", desktop: "4rem" },
  },
  airy: {
    cardMin: { phone: "9.75rem", tablet: "13rem", desktop: "16rem" },
    gap: { phone: "0.75rem", desktop: "1.5rem" },
    scale: "1",
    control: "3rem",
    section: { phone: "2rem", desktop: "6rem" },
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

/**
 * The storefront's local Bengali face (`apps/storefront/src/lib/theme-fonts.ts`):
 * the installed system Bengali font under one name, right after the Bengali
 * web family. Without it, the Taka sign of every price (outside the web
 * font's range) and Bangla text while that font loads fall to the platform's
 * font search on the first layout: about 35 ms on a laptop, 4x on a phone.
 */
export const STOREFRONT_BENGALI_SYSTEM_FONT = "Bengali System";

function fontStack(font: StorefrontFontKey, bangla: keyof typeof STOREFRONT_BANGLA_FONTS): string {
  const latin = STOREFRONT_FONTS[font];
  const bengali = STOREFRONT_BANGLA_FONTS[bangla];
  return `"${latin.family}", "${bengali.family}", "${STOREFRONT_BENGALI_SYSTEM_FONT}", ${latin.fallback}, ${bengali.fallback}`;
}

// ─── Palettes ─────────────────────────────────────────────────────────────

type Palette = Readonly<StorefrontThemeColors>;

/**
 * A palette from its colours. `input` (a field's border) is a tint the
 * palette names, taken toward the ink until it shows against the page and
 * the card (WCAG 1.4.11): the border is the only edge a text field has.
 */
function palette(colors: Omit<Palette, "popover" | "popover-foreground" | "ring"> & Partial<Palette>): Palette {
  return {
    popover: colors.card,
    "popover-foreground": colors["card-foreground"],
    ring: colors.primary,
    ...colors,
    input: storefrontThemeFieldBorder(colors),
  } as Palette;
}

/**
 * A colour set's field border as the palettes give it: its `input` tint
 * taken toward the ink until it shows (3:1) against the page and the card.
 * A border that already shows comes back as it is.
 */
export function storefrontThemeFieldBorder(colors: Pick<StorefrontThemeColors, "input" | "background" | "card" | "foreground">): string {
  return fieldBorder(colors.input, [colors.background, colors.card], colors.foreground);
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
  // Daraz/Target: bright white, near-black ink, cool neutral panels
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

/** `color` moved toward `toward` until it reads (AA, or `min`) on every surface; `toward` itself at worst. */
function readableOn(color: string, surfaces: readonly string[], toward: string, min = STOREFRONT_THEME_MIN_CONTRAST): string {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = storefrontThemeMix(color, toward, step / 20);
    if (surfaces.every((surface) => storefrontThemeContrast(candidate, surface) >= min)) return candidate;
  }
  return toward;
}

/** A field border that shows (3:1) on every surface, from its tint toward the ink. */
function fieldBorder(tint: string, surfaces: readonly string[], ink: string): string {
  return readableOn(tint, surfaces, ink, STOREFRONT_THEME_MIN_FIELD_BORDER_CONTRAST);
}

/** `color` moved toward black until its luminance is at most `luminance`. */
function deepened(color: string, luminance: number): string {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = storefrontThemeMix(color, "#000000", step / 20);
    if (storefrontThemeLuminance(candidate) <= luminance) return candidate;
  }
  return "#000000";
}

/**
 * Dark colours made from a theme's colours, for a merchant who turns on the
 * dark scheme (the dashboard stores them; nothing derives them when a page
 * renders). The page is the ink deepened to near black, so it keeps the
 * palette's tint; surfaces step up from it; text is the page colour; a dark
 * action colour (charcoal buttons) becomes the light ink, a coloured one
 * lightens until it reads on the page; the error colour lightens the same
 * way. Every result passes the readable-text rules of every block (tested).
 * Colours that are already dark come back as they are.
 */
export function storefrontDarkPalette(colors: StorefrontThemeColors): StorefrontThemeColors {
  if (storefrontThemeColorsAreDark(colors)) return { ...colors };
  const mix = storefrontThemeMix;
  const paper = colors.background;
  const background = deepened(colors.foreground, 0.008);
  const card = mix(background, paper, 0.05);
  const muted = mix(background, paper, 0.1);
  const neutralAction = storefrontThemeLuminance(colors.primary) < 0.1 && storefrontThemeChroma(colors.primary) <= STOREFRONT_THEME_MAX_MUTED_CHROMA;
  const lift = (color: string) => readableOn(color, [background, card, muted], "#ffffff");
  const coloured = neutralAction ? null : lift(colors.primary);
  const accent = mix(background, coloured ?? paper, coloured ? 0.2 : 0.14);
  const foreground = readableOn(mix(paper, background, 0.06), [background, card, muted, accent], "#ffffff");
  const primary = coloured ?? foreground;
  let mutedForeground = readableOn(mix(foreground, background, 0.38), [background, card, muted], foreground);
  if (storefrontThemeChroma(mutedForeground) > STOREFRONT_THEME_MAX_MUTED_CHROMA) mutedForeground = readableOn("#9c9c9c", [background, card, muted], "#ffffff");
  let destructive = lift(colors.destructive);
  for (let step = 1; step <= 10 && storefrontThemeColorDistance(mutedForeground, destructive) < STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE; step += 1) {
    destructive = lift(mix(colors.destructive, "#ff0000", step / 10));
  }
  return {
    background, foreground, card, "card-foreground": foreground, popover: card, "popover-foreground": foreground,
    primary, "primary-foreground": background,
    secondary: muted, "secondary-foreground": foreground,
    muted, "muted-foreground": mutedForeground,
    accent, "accent-foreground": foreground,
    destructive, "destructive-foreground": background,
    border: mix(background, paper, 0.16), input: fieldBorder(mix(background, paper, 0.24), [background, card], paper), ring: primary,
  };
}

// ─── Schema ───────────────────────────────────────────────────────────────

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, "Use a #rrggbb colour.");

/** One colour set: the 19 colour tokens. `colors` and `darkColors` are each one. */
export const storefrontThemeColorsSchema = z.object(
  Object.fromEntries(STOREFRONT_THEME_COLOR_KEYS.map((key) => [key, hexColorSchema])) as Record<
    StorefrontThemeColorKey,
    typeof hexColorSchema
  >,
).strict();

/**
 * The tokens with this colour set schema (the API passes it named, so its
 * contract states the 19 colours once for `colors` and `darkColors`).
 */
export const storefrontThemeTokensSchemaOf = (colorsSchema: typeof storefrontThemeColorsSchema = storefrontThemeColorsSchema) => z.object({
  colors: colorsSchema,
  /** Which colours buyers see (STOREFRONT_COLOR_SCHEMES). */
  colorScheme: z.enum(STOREFRONT_COLOR_SCHEMES),
  /**
   * The dark colours: the same tokens as `colors`, for dark pages. Required,
   * and held to the same readable-text rules, while buyers can see them
   * (`storefrontThemeShowsDarkColors`); kept as they are otherwise.
   */
  darkColors: z.union([colorsSchema, z.null()]),
  /** A switch in the header lets each buyer pick light or dark (remembered on their device). */
  colorSchemeToggle: z.boolean(),
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

export const storefrontThemeTokensSchema = storefrontThemeTokensSchemaOf();

export type StorefrontThemeTokens = z.infer<typeof storefrontThemeTokensSchema>;

/** Whether buyers can see the dark colours: a dark or device scheme, or the buyer's switch. */
export function storefrontThemeShowsDarkColors(tokens: Pick<StorefrontThemeTokens, "colorScheme" | "colorSchemeToggle">): boolean {
  return tokens.colorScheme !== "light" || tokens.colorSchemeToggle;
}

/** The light scheme with no dark colours and no switch: a look that leaves the scheme to the merchant. */
export const STOREFRONT_LIGHT_COLOR_SCHEME = { colorScheme: "light", darkColors: null, colorSchemeToggle: false } as const satisfies Pick<StorefrontThemeTokens, "colorScheme" | "darkColors" | "colorSchemeToggle">;

/** Whether dark colours are the ones made from these colours (the merchant has not edited them). */
export function storefrontDarkColorsAreMade(colors: StorefrontThemeColors, darkColors: StorefrontThemeColors): boolean {
  const made = storefrontDarkPalette(colors);
  return STOREFRONT_THEME_COLOR_KEYS.every((key) => made[key] === darkColors[key]);
}

type SchemeTokens = Pick<StorefrontThemeTokens, "colors" | "colorScheme" | "darkColors" | "colorSchemeToggle">;

/**
 * A look's tokens (a template's) over the store's: the merchant's colour
 * scheme and switch stay, unless the look shows dark colours of its own.
 * Dark colours the merchant edited stay too; ones made from the old
 * colours are made again from the look's, so dark pages follow the new look.
 */
export function storefrontTokensKeepingColorScheme<Tokens extends SchemeTokens>(look: Tokens, current: SchemeTokens | null): Tokens {
  if (!current || storefrontThemeShowsDarkColors(look)) return look;
  const edited = current.darkColors !== null && !storefrontDarkColorsAreMade(current.colors, current.darkColors);
  const darkColors = edited ? current.darkColors : current.darkColors && storefrontDarkPalette(look.colors);
  return { ...look, colorScheme: current.colorScheme, darkColors, colorSchemeToggle: current.colorSchemeToggle };
}

/** The rule every authored theme (a document, an app template) meets: dark colours whenever buyers can see them. */
export function storefrontDarkColorsMissing(tokens: Pick<StorefrontThemeTokens, "colorScheme" | "darkColors" | "colorSchemeToggle">): boolean {
  return storefrontThemeShowsDarkColors(tokens) && !tokens.darkColors;
}

// ─── CSS ──────────────────────────────────────────────────────────────────

/**
 * The custom properties that follow a colour set: its colours, the header's
 * surfaces (the header tone applied to it) and the sale colour. The dark
 * colours repaint exactly these.
 */
export function buildStorefrontColorCss(colors: StorefrontThemeColors, headerTone: StorefrontThemeHeaderTone) {
  const header = storefrontHeaderToneColors(headerTone, colors);
  const bands = storefrontHeaderBands(headerTone, colors);
  const dark = storefrontThemeColorsAreDark(colors);
  return {
    ...colors,
    "theme-header-background": colors[header.background],
    "theme-header-foreground": colors[header.foreground],
    "theme-header-deep": bands.deep,
    "theme-header-raised": bands.raised,
    "theme-sale": colors.destructive,
    // The ink surface (a dark footer): the darker of text and page, as the
    // dark header tone takes it, with the other on it (an AA pair either way).
    "theme-ink": dark ? colors.background : colors.foreground,
    "theme-ink-foreground": dark ? colors.foreground : colors.background,
  };
}

/** Whether a colour set is dark (its page darker than its text): the browser's own controls and scrollbars follow it. */
export function storefrontThemeColorsAreDark(colors: Pick<StorefrontThemeColors, "background" | "foreground">): boolean {
  return storefrontThemeLuminance(colors.background) < storefrontThemeLuminance(colors.foreground);
}

/** CSS custom properties for the tokens (the colours, not the dark colours): only constants and validated hex colours. */
export function buildStorefrontTokenCss(tokens: StorefrontThemeTokens): Record<string, string> {
  const density = STOREFRONT_DENSITY_SPECS[tokens.density];
  const type = STOREFRONT_TYPE_PAIRING_SPECS[tokens.typography];
  const scale = STOREFRONT_TYPE_SCALE_SPECS[tokens.typeScale];
  const colors = buildStorefrontColorCss(tokens.colors, tokens.headerTone);
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
    "theme-header-background": colors["theme-header-background"],
    "theme-header-foreground": colors["theme-header-foreground"],
    "theme-header-deep": colors["theme-header-deep"],
    "theme-header-raised": colors["theme-header-raised"],
    // Colour roles beyond the palette: sale is the error colour (discounted
    // prices and the sale badge only), rating and success are constants.
    "theme-sale": colors["theme-sale"],
    "theme-rating": STOREFRONT_RATING_COLOR,
    "theme-success": STOREFRONT_SUCCESS_COLOR,
    "theme-surface-border": STOREFRONT_ELEVATION[tokens.surface].border,
    "theme-surface-shadow": STOREFRONT_ELEVATION[tokens.surface].shadow,
    "theme-surface-pad-phone": `${STOREFRONT_SURFACE_PADDING.phone / 16}rem`,
    "theme-surface-pad-desktop": `${STOREFRONT_SURFACE_PADDING.desktop / 16}rem`,
    "theme-container-width": CONTAINER_TOKENS[tokens.container],
    "theme-gutter-phone": `${STOREFRONT_GUTTERS.phone / 16}rem`,
    "theme-gutter-tablet": `${STOREFRONT_GUTTERS.tablet / 16}rem`,
    "theme-gutter-desktop": `${STOREFRONT_GUTTERS.desktop / 16}rem`,
    "theme-duration-fast": `${STOREFRONT_MOTION_MS.fast}ms`,
    "theme-duration-base": `${STOREFRONT_MOTION_MS.base}ms`,
    ...Object.fromEntries(Object.entries(STOREFRONT_TYPE_STEPS).map(([step, px]) => [`theme-text-${step}`, `${px / 16}rem`])),
  };
}
