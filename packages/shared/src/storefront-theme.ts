// The storefront theme document (version 2): one versioned JSON document that
// the dashboard Theme page and a future AI builder both write, and that the
// storefront renders from in either mode. The contract is documented in
// ./storefront-theme.md; `storefrontThemeDocumentSchema` is the only way in.
import { z } from "zod";

export const STOREFRONT_THEME_DOCUMENT_VERSION = 3 as const;

/**
 * `configured`: built from the Theme page's curated choices.
 * `custom`: owned by a builder; the Theme page shows its options disabled.
 */
export const STOREFRONT_THEME_MODES = ["configured", "custom"] as const;

// ─── Tokens ───────────────────────────────────────────────────────────────

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
/** Button corners follow the theme radius, or are fully rounded (pill). */
export const STOREFRONT_THEME_BUTTON_SHAPES = ["radius", "pill"] as const;
export const STOREFRONT_THEME_RADII = ["square", "subtle", "rounded"] as const;
export const STOREFRONT_THEME_CONTAINER_WIDTHS = ["standard", "wide"] as const;
export const STOREFRONT_THEME_BUTTON_STYLES = ["solid", "outline"] as const;
export const STOREFRONT_THEME_INPUT_STYLES = ["outlined", "filled"] as const;
export const STOREFRONT_THEME_CARD_SURFACES = ["bordered", "elevated", "flat"] as const;

export type StorefrontThemeColorKey = (typeof STOREFRONT_THEME_COLOR_KEYS)[number];

/**
 * Text/background token pairs the storefront renders. Every document must
 * meet WCAG 1.4.3 AA (4.5:1) on each, so no colour choice can ship
 * unreadable text.
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
] as const satisfies ReadonlyArray<readonly [StorefrontThemeColorKey, StorefrontThemeColorKey]>;

export const STOREFRONT_THEME_MIN_CONTRAST = 4.5;

/**
 * Helper text is not an error. Secondary ("muted") text stays near-neutral
 * (Lab chroma at most this) so a brand accent never reads as a warning...
 */
export const STOREFRONT_THEME_MAX_MUTED_CHROMA = 25;
/** ...and stays clearly apart from the error colour (CIE76 colour distance). */
export const STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE = 40;

// ─── Layout: five independent, curated choices ────────────────────────────

export const STOREFRONT_HEADER_STYLES = ["classic", "centered", "marketplace"] as const;
export const STOREFRONT_FOOTER_STYLES = ["columns", "compact", "contact"] as const;
/**
 * Card styles bundle photo shape, hover photo, buy-now and badge placement
 * into three combinations that each work at every density and preset.
 */
export const STOREFRONT_CARD_STYLES = ["standard", "portrait", "quick"] as const;
/**
 * Density: how much fits on screen. Grids are fluid (auto-fill columns with a
 * minimum card width that steps up with the grid's own container width), so
 * columns follow the space from 360px phones to ultra-wide screens. Density
 * sets that minimum width, the gaps and the type/spacing scale. Both
 * densities give two product columns on phones.
 */
export const STOREFRONT_DENSITIES = ["compact", "comfortable"] as const;
/** Product page: gallery placement and thumbnails chosen together. */
export const STOREFRONT_PRODUCT_PAGE_LAYOUTS = ["gallery", "filmstrip", "stacked"] as const;
/**
 * How buyers browse the store's header menu (Online store -> Navigation)
 * on computers:
 * - `menu`: a horizontal menu; items with children open a dropdown list.
 * - `mega`: a horizontal menu; items with children open a full-width panel
 *   of columns, with category photos where the menu links a category.
 * - `pills`: a scrolling row of rounded category links under the header
 *   (marketplace style); children are reached from the parent's page.
 * - `sidebar`: a category list in a left column beside the page content
 *   (grocery / marketplace catalogues), with expandable children.
 */
export const STOREFRONT_NAVIGATION_STYLES = ["menu", "mega", "pills", "sidebar"] as const;
/**
 * Navigation on phones: `drawer` opens the menu from the header button as a
 * side sheet with accordion levels; `tabs` adds a bottom tab bar (Home,
 * Categories, Search, Cart, Account) for marketplace-style stores, with the
 * menu drawer behind Categories.
 */
export const STOREFRONT_MOBILE_NAVIGATION_STYLES = ["drawer", "tabs"] as const;

export type StorefrontHeaderStyle = (typeof STOREFRONT_HEADER_STYLES)[number];
export type StorefrontFooterStyle = (typeof STOREFRONT_FOOTER_STYLES)[number];
export type StorefrontCardStyle = (typeof STOREFRONT_CARD_STYLES)[number];
export type StorefrontDensity = (typeof STOREFRONT_DENSITIES)[number];
export type StorefrontProductPageLayout = (typeof STOREFRONT_PRODUCT_PAGE_LAYOUTS)[number];
export type StorefrontNavigationStyle = (typeof STOREFRONT_NAVIGATION_STYLES)[number];
export type StorefrontMobileNavigationStyle = (typeof STOREFRONT_MOBILE_NAVIGATION_STYLES)[number];

/** What each card style means for the storefront. */
export const STOREFRONT_CARD_STYLE_SPECS = {
  standard: { imageRatio: "square", hoverImage: false, quickBuy: false, badge: "image" },
  portrait: { imageRatio: "portrait", hoverImage: true, quickBuy: false, badge: "image" },
  quick: { imageRatio: "square", hoverImage: false, quickBuy: true, badge: "price" },
} as const satisfies Record<StorefrontCardStyle, {
  imageRatio: "square" | "portrait";
  hoverImage: boolean;
  quickBuy: boolean;
  badge: "image" | "price";
}>;

/**
 * Fluid grid facts per density. `cardMin` is the minimum product card width
 * for a grid container narrower than 36rem (phone), 36-60rem (tablet) and
 * wider (desktop); `gap` is the grid gap at phone and desktop widths;
 * `scale` multiplies the fluid type and spacing scale.
 */
export const STOREFRONT_DENSITY_SPECS = {
  compact: {
    cardMin: { phone: "9.25rem", tablet: "11rem", desktop: "12.5rem" },
    gap: { phone: "0.5rem", desktop: "1rem" },
    scale: "0.92",
  },
  comfortable: {
    cardMin: { phone: "9.75rem", tablet: "13rem", desktop: "15rem" },
    gap: { phone: "0.75rem", desktop: "1.5rem" },
    scale: "1",
  },
} as const satisfies Record<StorefrontDensity, {
  cardMin: { phone: string; tablet: string; desktop: string };
  gap: { phone: string; desktop: string };
  scale: string;
}>;

/** Gallery placement and thumbnail strip per product page layout. */
export const STOREFRONT_PRODUCT_PAGE_SPECS = {
  gallery: { gallery: "beside", thumbnails: "beside" },
  filmstrip: { gallery: "beside", thumbnails: "below" },
  stacked: { gallery: "stacked", thumbnails: "below" },
} as const satisfies Record<StorefrontProductPageLayout, {
  gallery: "beside" | "stacked";
  thumbnails: "beside" | "below";
}>;

// ─── Sections ─────────────────────────────────────────────────────────────

const sectionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);

/**
 * The section registry. Each entry is a versioned section schema. `editor`
 * says who edits it: `theme` sections are the fixed homepage blocks the
 * Theme page reorders; `builder` sections are created and edited by the
 * builder (the Theme page lists them as "Custom section"). Adding a section
 * type means adding an entry here and a renderer on the storefront.
 */
export const STOREFRONT_SECTION_REGISTRY = {
  hero: {
    version: 1,
    editor: "theme",
    schema: z.object({
      id: sectionIdSchema,
      type: z.literal("hero"),
      version: z.literal(1),
      settings: z.object({}).strict(),
    }).strict(),
  },
  collections: {
    version: 1,
    editor: "theme",
    schema: z.object({
      id: sectionIdSchema,
      type: z.literal("collections"),
      version: z.literal(1),
      settings: z.object({}).strict(),
    }).strict(),
  },
  categories: {
    version: 1,
    editor: "theme",
    schema: z.object({
      id: sectionIdSchema,
      type: z.literal("categories"),
      version: z.literal(1),
      settings: z.object({}).strict(),
    }).strict(),
  },
  delivery: {
    version: 1,
    editor: "theme",
    schema: z.object({
      id: sectionIdSchema,
      type: z.literal("delivery"),
      version: z.literal(1),
      settings: z.object({}).strict(),
    }).strict(),
  },
  rich_text: {
    version: 1,
    editor: "builder",
    schema: z.object({
      id: sectionIdSchema,
      type: z.literal("rich_text"),
      version: z.literal(1),
      settings: z.object({
        heading: z.string().trim().max(120),
        body: z.string().trim().max(2000),
      }).strict(),
    }).strict(),
  },
} as const;

export type StorefrontSectionType = keyof typeof STOREFRONT_SECTION_REGISTRY;
export const STOREFRONT_SECTION_TYPES = Object.keys(STOREFRONT_SECTION_REGISTRY) as StorefrontSectionType[];
/** The homepage blocks the Theme page owns; a configured document has each exactly once. */
export const STOREFRONT_THEME_SECTION_TYPES = STOREFRONT_SECTION_TYPES.filter(
  (type) => STOREFRONT_SECTION_REGISTRY[type].editor === "theme",
);
export const STOREFRONT_MAX_SECTIONS = 24;

const sectionSchema = z.discriminatedUnion("type", [
  STOREFRONT_SECTION_REGISTRY.hero.schema,
  STOREFRONT_SECTION_REGISTRY.collections.schema,
  STOREFRONT_SECTION_REGISTRY.categories.schema,
  STOREFRONT_SECTION_REGISTRY.delivery.schema,
  STOREFRONT_SECTION_REGISTRY.rich_text.schema,
]);

export type StorefrontSection = z.infer<typeof sectionSchema>;

// ─── Document ─────────────────────────────────────────────────────────────

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, "Use a #rrggbb colour.");

export const storefrontThemeTokensSchema = z.object({
  colors: z.object(
    Object.fromEntries(STOREFRONT_THEME_COLOR_KEYS.map((key) => [key, hexColorSchema])) as Record<
      StorefrontThemeColorKey,
      typeof hexColorSchema
    >,
  ).strict(),
  typography: z.enum(STOREFRONT_TYPE_PAIRINGS),
  radius: z.enum(STOREFRONT_THEME_RADII),
  buttonShape: z.enum(STOREFRONT_THEME_BUTTON_SHAPES),
  containerWidth: z.enum(STOREFRONT_THEME_CONTAINER_WIDTHS),
  components: z.object({
    buttons: z.enum(STOREFRONT_THEME_BUTTON_STYLES),
    inputs: z.enum(STOREFRONT_THEME_INPUT_STYLES),
    cards: z.enum(STOREFRONT_THEME_CARD_SURFACES),
  }).strict(),
}).strict();

export const storefrontThemeLayoutSchema = z.object({
  header: z.enum(STOREFRONT_HEADER_STYLES),
  footer: z.enum(STOREFRONT_FOOTER_STYLES),
  card: z.enum(STOREFRONT_CARD_STYLES),
  density: z.enum(STOREFRONT_DENSITIES),
  productPage: z.enum(STOREFRONT_PRODUCT_PAGE_LAYOUTS),
  navigation: z.enum(STOREFRONT_NAVIGATION_STYLES),
  mobileNavigation: z.enum(STOREFRONT_MOBILE_NAVIGATION_STYLES),
}).strict();

/** The complete, strict theme document schema. Writes and reads both use it. */
export const storefrontThemeDocumentSchema = z.object({
  version: z.literal(STOREFRONT_THEME_DOCUMENT_VERSION),
  mode: z.enum(STOREFRONT_THEME_MODES),
  tokens: storefrontThemeTokensSchema,
  layout: storefrontThemeLayoutSchema,
  sections: z.array(sectionSchema).max(STOREFRONT_MAX_SECTIONS),
}).strict().superRefine((document, context) => {
  for (const [text, surface] of STOREFRONT_THEME_TEXT_PAIRS) {
    const ratio = storefrontThemeContrast(document.tokens.colors[text], document.tokens.colors[surface]);
    if (ratio < STOREFRONT_THEME_MIN_CONTRAST) {
      context.addIssue({
        code: "custom",
        path: ["tokens", "colors", text],
        message: `${text} on ${surface} has contrast ${ratio.toFixed(2)}:1; it needs at least ${STOREFRONT_THEME_MIN_CONTRAST}:1.`,
      });
    }
  }
  for (const problem of listStorefrontThemeSemanticColorProblems(document.tokens.colors)) {
    context.addIssue({ code: "custom", path: ["tokens", "colors", "muted-foreground"], message: problem });
  }
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  document.sections.forEach((section, index) => {
    if (ids.has(section.id)) {
      context.addIssue({ code: "custom", path: ["sections", index, "id"], message: "Section ids must be unique." });
    }
    ids.add(section.id);
    counts.set(section.type, (counts.get(section.type) ?? 0) + 1);
  });
  for (const type of STOREFRONT_THEME_SECTION_TYPES) {
    const count = counts.get(type) ?? 0;
    if (count > 1 || (document.mode === "configured" && count !== 1)) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: document.mode === "configured"
          ? `A configured theme has the ${type} section exactly once.`
          : `The ${type} section can appear at most once.`,
      });
    }
  }
});

export type StorefrontThemeDocument = z.infer<typeof storefrontThemeDocumentSchema>;
export type StorefrontThemeMode = StorefrontThemeDocument["mode"];
export type StorefrontThemeTokens = StorefrontThemeDocument["tokens"];
export type StorefrontThemeLayout = StorefrontThemeDocument["layout"];

/** JSON Schema of the document (structure only; contrast and section rules are in the Zod schema). */
export function storefrontThemeDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(storefrontThemeDocumentSchema, { unrepresentable: "any" }) as Record<string, unknown>;
}

/**
 * Parses a stored document strictly. Returns null for anything that is not a
 * valid current-version document; callers decide what that means (the
 * dashboard fails closed, the storefront renders the default theme).
 */
export function parseStoredStorefrontThemeDocument(value: string | null | undefined): StorefrontThemeDocument | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = storefrontThemeDocumentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// ─── Resolved layout (what the storefront renders) ────────────────────────

export interface ResolvedStorefrontThemeLayout {
  header: StorefrontHeaderStyle;
  footer: StorefrontFooterStyle;
  productCard: (typeof STOREFRONT_CARD_STYLE_SPECS)[StorefrontCardStyle];
  density: StorefrontDensity;
  grid: (typeof STOREFRONT_DENSITY_SPECS)[StorefrontDensity];
  productPage: (typeof STOREFRONT_PRODUCT_PAGE_SPECS)[StorefrontProductPageLayout];
  navigation: StorefrontNavigationStyle;
  mobileNavigation: StorefrontMobileNavigationStyle;
}

export function resolveStorefrontThemeLayout(layout: StorefrontThemeLayout): ResolvedStorefrontThemeLayout {
  return {
    header: layout.header,
    footer: layout.footer,
    productCard: STOREFRONT_CARD_STYLE_SPECS[layout.card],
    density: layout.density,
    grid: STOREFRONT_DENSITY_SPECS[layout.density],
    productPage: STOREFRONT_PRODUCT_PAGE_SPECS[layout.productPage],
    navigation: layout.navigation,
    mobileNavigation: layout.mobileNavigation,
  };
}

// ─── Colour maths ─────────────────────────────────────────────────────────

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function storefrontThemeContrast(foreground: string, background: string): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Text pairs below AA for a colour map (empty when every pair passes). */
export function listStorefrontThemeContrastProblems(
  colors: Record<StorefrontThemeColorKey, string>,
): Array<{ text: StorefrontThemeColorKey; surface: StorefrontThemeColorKey; ratio: number }> {
  return STOREFRONT_THEME_TEXT_PAIRS.flatMap(([text, surface]) => {
    const ratio = storefrontThemeContrast(colors[text], colors[surface]);
    return ratio < STOREFRONT_THEME_MIN_CONTRAST ? [{ text, surface, ratio }] : [];
  });
}

function lab(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
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

/** Semantic-role problems: helper text that is tinted or looks like an error. */
export function listStorefrontThemeSemanticColorProblems(
  colors: Record<StorefrontThemeColorKey, string>,
): string[] {
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

export function isStorefrontThemeHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value);
}

// ─── CSS tokens ───────────────────────────────────────────────────────────

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
} as const satisfies Record<(typeof STOREFRONT_TYPE_PAIRINGS)[number], {
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

export type StorefrontTypePairing = (typeof STOREFRONT_TYPE_PAIRINGS)[number];

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

const RADIUS_TOKENS = { square: "0rem", subtle: "0.4rem", rounded: "0.75rem" } as const;
/** Content is capped so ultra-wide screens keep a readable measure. */
const CONTAINER_TOKENS = { standard: "76rem", wide: "90rem" } as const;

/** CSS custom properties for a document: only constants and validated hex colours. */
export function buildStorefrontThemeTokens(document: StorefrontThemeDocument): Record<string, string> {
  const { tokens } = document;
  const density = STOREFRONT_DENSITY_SPECS[document.layout.density];
  const type = STOREFRONT_TYPE_PAIRING_SPECS[tokens.typography];
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
    radius: RADIUS_TOKENS[tokens.radius],
    "theme-button-radius": tokens.buttonShape === "pill" ? "9999px" : RADIUS_TOKENS[tokens.radius],
    "theme-density-scale": density.scale,
    "theme-card-min-phone": density.cardMin.phone,
    "theme-card-min-tablet": density.cardMin.tablet,
    "theme-card-min-desktop": density.cardMin.desktop,
    "theme-grid-gap-phone": density.gap.phone,
    "theme-grid-gap-desktop": density.gap.desktop,
    "theme-container-width": CONTAINER_TOKENS[tokens.containerWidth],
  };
}

// ─── Palettes and Style presets ───────────────────────────────────────────

type Palette = Readonly<Record<StorefrontThemeColorKey, string>>;

function palette(colors: Omit<Palette, "popover" | "popover-foreground" | "ring"> & Partial<Palette>): Palette {
  return {
    popover: colors.card,
    "popover-foreground": colors["card-foreground"],
    ring: colors.primary,
    ...colors,
  } as Palette;
}

/** Colour palettes behind the Style presets; each passes every AA text pair (tested). */
/**
 * Curated palettes, one system per Style: ink, a single restrained brand
 * colour, neutrals tinted toward the palette's hue (never raw grey on a warm
 * page), surfaces, and semantic tones. Each passes every AA text pair and
 * the helper-vs-error rule (tested). Rationale per palette:
 * storefront-theme.md.
 */
export const STOREFRONT_THEME_PALETTES = {
  // Horizon/Dawn, Allbirds: warm white paper, charcoal ink, charcoal
  // buttons; sand neutrals carry the warmth, the brand colour stays quiet.
  retail: palette({
    background: "#fbfaf7", foreground: "#1d1c1a", card: "#ffffff", "card-foreground": "#1d1c1a",
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

const DEFAULT_SECTIONS: StorefrontSection[] = STOREFRONT_THEME_SECTION_TYPES.map((type) => ({
  id: type,
  type,
  version: 1,
  settings: {},
})) as StorefrontSection[];

function themeSections(order: readonly StorefrontSectionType[]): StorefrontSection[] {
  return order.map((type) => DEFAULT_SECTIONS.find((section) => section.type === type)!);
}

/**
 * Style presets: complete configured documents, each anchored to named
 * world-class references (storefront-theme.md) and tuned for the verticals
 * Bangladeshi stores sell in.
 */
export const STOREFRONT_STYLE_PRESETS = [
  {
    // Horizon/Dawn, Allbirds. General retail.
    key: "classic",
    palette: "retail",
    tokens: {
      typography: "retail", radius: "subtle", buttonShape: "radius", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "bordered" },
    },
    layout: { header: "classic", footer: "columns", card: "standard", density: "compact", productPage: "gallery", navigation: "menu", mobileNavigation: "drawer" },
    sections: ["hero", "collections", "categories", "delivery"],
  },
  {
    // Amazon/Daraz density done cleanly, Target. Electronics and marketplaces.
    key: "marketplace",
    palette: "marketplace",
    tokens: {
      typography: "market", radius: "subtle", buttonShape: "radius", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "bordered" },
    },
    layout: { header: "marketplace", footer: "contact", card: "quick", density: "compact", productPage: "filmstrip", navigation: "pills", mobileNavigation: "tabs" },
    sections: ["hero", "categories", "collections", "delivery"],
  },
  {
    // COS, Aesop, Ssense. Fashion: tall photos, second photo on hover.
    key: "boutique",
    palette: "boutique",
    tokens: {
      typography: "editorial", radius: "square", buttonShape: "radius", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "flat" },
    },
    layout: { header: "centered", footer: "columns", card: "portrait", density: "comfortable", productPage: "gallery", navigation: "mega", mobileNavigation: "drawer" },
    sections: ["hero", "collections", "categories", "delivery"],
  },
  {
    // Instacart, Chaldal, Ocado. Grocery and daily needs.
    key: "daily",
    palette: "fresh",
    tokens: {
      typography: "fresh", radius: "rounded", buttonShape: "pill", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "bordered" },
    },
    layout: { header: "marketplace", footer: "contact", card: "quick", density: "compact", productPage: "filmstrip", navigation: "sidebar", mobileNavigation: "tabs" },
    sections: ["categories", "hero", "delivery", "collections"],
  },
  {
    // Glossier, Sephora. Cosmetics and beauty.
    key: "beauty",
    palette: "beauty",
    tokens: {
      typography: "beauty", radius: "rounded", buttonShape: "pill", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "flat" },
    },
    layout: { header: "classic", footer: "contact", card: "portrait", density: "comfortable", productPage: "filmstrip", navigation: "mega", mobileNavigation: "drawer" },
    sections: ["hero", "categories", "collections", "delivery"],
  },
  {
    // Aarong, Anthropologie, Fabindia. Handicrafts and heritage.
    key: "heritage",
    palette: "heritage",
    tokens: {
      typography: "heritage", radius: "square", buttonShape: "radius", containerWidth: "standard",
      components: { buttons: "solid", inputs: "outlined", cards: "flat" },
    },
    layout: { header: "centered", footer: "columns", card: "portrait", density: "comfortable", productPage: "stacked", navigation: "menu", mobileNavigation: "drawer" },
    sections: ["hero", "collections", "delivery", "categories"],
  },
  {
    // Apple, Nothing, Linear-style dark. Electronics and premium.
    key: "midnight",
    palette: "midnight",
    tokens: {
      typography: "tech", radius: "rounded", buttonShape: "pill", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "elevated" },
    },
    layout: { header: "classic", footer: "columns", card: "standard", density: "compact", productPage: "gallery", navigation: "mega", mobileNavigation: "drawer" },
    sections: ["hero", "collections", "categories", "delivery"],
  },
] as const satisfies ReadonlyArray<{
  key: string;
  palette: StorefrontThemePaletteKey;
  tokens: Omit<StorefrontThemeTokens, "colors">;
  layout: StorefrontThemeLayout;
  sections: readonly StorefrontSectionType[];
}>;

export type StorefrontStylePresetKey = (typeof STOREFRONT_STYLE_PRESETS)[number]["key"];
export const STOREFRONT_STYLE_PRESET_KEYS = STOREFRONT_STYLE_PRESETS.map((preset) => preset.key);

/** The complete configured document a Style preset stands for. */
export function storefrontStylePresetTheme(key: StorefrontStylePresetKey): StorefrontThemeDocument {
  const preset = STOREFRONT_STYLE_PRESETS.find((candidate) => candidate.key === key)!;
  return {
    version: STOREFRONT_THEME_DOCUMENT_VERSION,
    mode: "configured",
    tokens: {
      ...structuredClone(preset.tokens),
      colors: { ...STOREFRONT_THEME_PALETTES[preset.palette] },
    } as StorefrontThemeTokens,
    layout: { ...preset.layout },
    sections: structuredClone(themeSections(preset.sections)),
  };
}

/** Every store without a saved theme renders this (the Classic preset). */
export const DEFAULT_STOREFRONT_THEME: StorefrontThemeDocument = storefrontStylePresetTheme("classic");
