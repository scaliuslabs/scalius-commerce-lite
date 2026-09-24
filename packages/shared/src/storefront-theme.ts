// The storefront theme document (version 2): one versioned JSON document that
// the dashboard Theme page and a future AI builder both write, and that the
// storefront renders from in either mode. The contract is documented in
// ./storefront-theme.md; `storefrontThemeDocumentSchema` is the only way in.
import { z } from "zod";

export const STOREFRONT_THEME_DOCUMENT_VERSION = 2 as const;

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

export const STOREFRONT_THEME_HEADING_FONTS = ["system", "modern", "editorial"] as const;
export const STOREFRONT_THEME_BODY_FONTS = ["system", "modern", "humanist"] as const;
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

export type StorefrontHeaderStyle = (typeof STOREFRONT_HEADER_STYLES)[number];
export type StorefrontFooterStyle = (typeof STOREFRONT_FOOTER_STYLES)[number];
export type StorefrontCardStyle = (typeof STOREFRONT_CARD_STYLES)[number];
export type StorefrontDensity = (typeof STOREFRONT_DENSITIES)[number];
export type StorefrontProductPageLayout = (typeof STOREFRONT_PRODUCT_PAGE_LAYOUTS)[number];

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
  typography: z.object({
    heading: z.enum(STOREFRONT_THEME_HEADING_FONTS),
    body: z.enum(STOREFRONT_THEME_BODY_FONTS),
  }).strict(),
  radius: z.enum(STOREFRONT_THEME_RADII),
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
}

export function resolveStorefrontThemeLayout(layout: StorefrontThemeLayout): ResolvedStorefrontThemeLayout {
  return {
    header: layout.header,
    footer: layout.footer,
    productCard: STOREFRONT_CARD_STYLE_SPECS[layout.card],
    density: layout.density,
    grid: STOREFRONT_DENSITY_SPECS[layout.density],
    productPage: STOREFRONT_PRODUCT_PAGE_SPECS[layout.productPage],
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

const FONT_FAMILIES = {
  heading: {
    system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    modern: '"Avenir Next", Avenir, "Segoe UI", ui-sans-serif, sans-serif',
    editorial: 'Georgia, "Times New Roman", ui-serif, serif',
  },
  body: {
    system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    modern: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    humanist: 'Optima, Candara, "Noto Sans", ui-sans-serif, sans-serif',
  },
} as const;

const RADIUS_TOKENS = { square: "0rem", subtle: "0.4rem", rounded: "0.75rem" } as const;
/** Content is capped so ultra-wide screens keep a readable measure. */
const CONTAINER_TOKENS = { standard: "76rem", wide: "90rem" } as const;

/** CSS custom properties for a document: only constants and validated hex colours. */
export function buildStorefrontThemeTokens(document: StorefrontThemeDocument): Record<string, string> {
  const { tokens } = document;
  const density = STOREFRONT_DENSITY_SPECS[document.layout.density];
  return {
    ...tokens.colors,
    "theme-font-heading": FONT_FAMILIES.heading[tokens.typography.heading],
    "theme-font-body": FONT_FAMILIES.body[tokens.typography.body],
    "theme-type-scale": density.scale,
    radius: RADIUS_TOKENS[tokens.radius],
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
export const STOREFRONT_THEME_PALETTES = {
  everyday: palette({
    background: "#ffffff", foreground: "#18181b", card: "#ffffff", "card-foreground": "#18181b",
    primary: "#11813c", "primary-foreground": "#ffffff",
    secondary: "#f4f4f5", "secondary-foreground": "#27272a",
    muted: "#f4f4f5", "muted-foreground": "#5f5f69",
    accent: "#f4f4f5", "accent-foreground": "#18181b",
    destructive: "#c70009", "destructive-foreground": "#ffffff",
    border: "#e4e4e7", input: "#d4d4d8",
  }),
  marketplace: palette({
    background: "#ffffff", foreground: "#1c1917", card: "#ffffff", "card-foreground": "#1c1917",
    primary: "#c2410c", "primary-foreground": "#ffffff",
    secondary: "#fff7ed", "secondary-foreground": "#7c2d12",
    muted: "#f5f5f4", "muted-foreground": "#57534e",
    accent: "#ffedd5", "accent-foreground": "#7c2d12",
    destructive: "#b91c1c", "destructive-foreground": "#ffffff",
    border: "#e7e5e4", input: "#d6d3d1",
  }),
  boutique: palette({
    background: "#ffffff", foreground: "#09090b", card: "#ffffff", "card-foreground": "#09090b",
    primary: "#18181b", "primary-foreground": "#fafafa",
    secondary: "#f4f4f5", "secondary-foreground": "#18181b",
    muted: "#f4f4f5", "muted-foreground": "#52525b",
    accent: "#f4f4f5", "accent-foreground": "#18181b",
    destructive: "#b91c1c", "destructive-foreground": "#ffffff",
    border: "#e4e4e7", input: "#d4d4d8", ring: "#09090b",
  }),
  fresh: palette({
    background: "#ffffff", foreground: "#022c22", card: "#ffffff", "card-foreground": "#022c22",
    primary: "#047857", "primary-foreground": "#ffffff",
    secondary: "#d1fae5", "secondary-foreground": "#064e3b",
    muted: "#ecfdf5", "muted-foreground": "#4a5b53",
    accent: "#a7f3d0", "accent-foreground": "#064e3b",
    destructive: "#b91c1c", "destructive-foreground": "#ffffff",
    border: "#a7f3d0", input: "#6ee7b7",
  }),
  beauty: palette({
    background: "#fffafb", foreground: "#3b0a24", card: "#ffffff", "card-foreground": "#3b0a24",
    primary: "#9d174d", "primary-foreground": "#ffffff",
    secondary: "#fce7f3", "secondary-foreground": "#831843",
    muted: "#fdf2f8", "muted-foreground": "#6b5a62",
    accent: "#fbcfe8", "accent-foreground": "#831843",
    destructive: "#b91c1c", "destructive-foreground": "#ffffff",
    border: "#fbcfe8", input: "#f9a8d4",
  }),
  heritage: palette({
    background: "#fbf7f0", foreground: "#2b1d12", card: "#fffdf9", "card-foreground": "#2b1d12",
    primary: "#9a3412", "primary-foreground": "#ffffff",
    secondary: "#f3e8d7", "secondary-foreground": "#4a2c14",
    muted: "#f3ebe0", "muted-foreground": "#6b5646",
    accent: "#ecdcc4", "accent-foreground": "#4a2c14",
    destructive: "#b91c1c", "destructive-foreground": "#ffffff",
    border: "#e5d5bd", input: "#d6c1a1",
  }),
  midnight: palette({
    background: "#09090b", foreground: "#fafafa", card: "#18181b", "card-foreground": "#fafafa",
    primary: "#fafafa", "primary-foreground": "#18181b",
    secondary: "#27272a", "secondary-foreground": "#fafafa",
    muted: "#27272a", "muted-foreground": "#d4d4d8",
    accent: "#3f3f46", "accent-foreground": "#fafafa",
    // Error text sits on the dark background, so the red must be light.
    destructive: "#f87171", "destructive-foreground": "#09090b",
    border: "#3f3f46", input: "#3f3f46", ring: "#d4d4d8",
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
 * Style presets: complete configured documents tuned for the verticals
 * Bangladeshi stores sell in, with Shopify Dawn/Horizon and leading BD stores
 * (Daraz, Chaldal, Aarong, Shajgoj, Star Tech) as the bar.
 */
export const STOREFRONT_STYLE_PRESETS = [
  {
    key: "classic",
    palette: "everyday",
    tokens: {
      typography: { heading: "system", body: "system" },
      radius: "subtle", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "bordered" },
    },
    layout: { header: "classic", footer: "columns", card: "standard", density: "compact", productPage: "gallery" },
    sections: ["hero", "collections", "categories", "delivery"],
  },
  {
    // Electronics and marketplaces: search first, compact grid, buy-now cards.
    key: "marketplace",
    palette: "marketplace",
    tokens: {
      typography: { heading: "system", body: "system" },
      radius: "subtle", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "elevated" },
    },
    layout: { header: "marketplace", footer: "contact", card: "quick", density: "compact", productPage: "filmstrip" },
    sections: ["hero", "categories", "collections", "delivery"],
  },
  {
    // Fashion: tall photos, second photo on hover, quiet type.
    key: "boutique",
    palette: "boutique",
    tokens: {
      typography: { heading: "editorial", body: "modern" },
      radius: "square", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "flat" },
    },
    layout: { header: "centered", footer: "columns", card: "portrait", density: "comfortable", productPage: "gallery" },
    sections: ["hero", "collections", "categories", "delivery"],
  },
  {
    // Grocery and daily needs: categories first, delivery facts, buy-now.
    key: "daily",
    palette: "fresh",
    tokens: {
      typography: { heading: "modern", body: "system" },
      radius: "rounded", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "bordered" },
    },
    layout: { header: "marketplace", footer: "contact", card: "quick", density: "compact", productPage: "filmstrip" },
    sections: ["categories", "hero", "delivery", "collections"],
  },
  {
    // Cosmetics and beauty: soft palette, portrait cards, comfortable grid.
    key: "beauty",
    palette: "beauty",
    tokens: {
      typography: { heading: "editorial", body: "system" },
      radius: "rounded", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "flat" },
    },
    layout: { header: "classic", footer: "contact", card: "portrait", density: "comfortable", productPage: "filmstrip" },
    sections: ["hero", "categories", "collections", "delivery"],
  },
  {
    // Handicrafts and heritage: warm paper tones, large photos, story first.
    key: "heritage",
    palette: "heritage",
    tokens: {
      typography: { heading: "editorial", body: "humanist" },
      radius: "square", containerWidth: "standard",
      components: { buttons: "solid", inputs: "outlined", cards: "flat" },
    },
    layout: { header: "centered", footer: "columns", card: "portrait", density: "comfortable", productPage: "stacked" },
    sections: ["hero", "collections", "delivery", "categories"],
  },
  {
    // A dark look for electronics and premium catalogues.
    key: "midnight",
    palette: "midnight",
    tokens: {
      typography: { heading: "modern", body: "modern" },
      radius: "subtle", containerWidth: "wide",
      components: { buttons: "solid", inputs: "filled", cards: "elevated" },
    },
    layout: { header: "classic", footer: "columns", card: "standard", density: "compact", productPage: "gallery" },
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
