// Historical read conversions only (upgrade.md). Each step is structural and
// uses only literals frozen with the version it reads, never today's
// registries, so a later version never changes what an older step produces.
// Today's defaults enter once, after the last step (`withCurrentDefaults`).
// A new document version adds one entry to THEME_UPGRADES.
import { z } from "zod";
import { STOREFRONT_BLOCK_REGISTRY } from "./blocks";
import { STOREFRONT_SECTION_REGISTRY } from "./sections";

type RecordValue = Record<string, unknown>;
// Pre-v2 defaults were CSS colours, not the later retail palette.
const V1_COLORS: Record<string, string> = {
  background: "oklch(1 0 0)", foreground: "oklch(0.21 0.006 285.885)", card: "oklch(1 0 0)", "card-foreground": "oklch(0.21 0.006 285.885)",
  popover: "oklch(1 0 0)", "popover-foreground": "oklch(0.21 0.006 285.885)", primary: "oklch(0.53 0.14 150)", "primary-foreground": "oklch(0.985 0 0)",
  secondary: "oklch(0.967 0.001 286.375)", "secondary-foreground": "oklch(0.274 0.006 286.033)", muted: "oklch(0.967 0.001 286.375)", "muted-foreground": "oklch(0.52 0.016 285.938)",
  accent: "oklch(0.967 0.001 286.375)", "accent-foreground": "oklch(0.21 0.006 285.885)", destructive: "oklch(0.577 0.245 27.325)", "destructive-foreground": "oklch(0.985 0 0)",
  border: "oklch(0.92 0.004 286.32)", input: "oklch(0.92 0.004 286.32)", ring: "oklch(0.53 0.14 150 / 0.5)",
  "chart-1": "oklch(0.646 0.222 41.116)", "chart-2": "oklch(0.6 0.118 184.704)", "chart-3": "oklch(0.398 0.07 227.392)", "chart-4": "oklch(0.828 0.189 84.429)", "chart-5": "oklch(0.769 0.188 70.08)",
};
const V1_HOME = ["hero", "collections", "categories", "delivery"] as const;
const V1_LAYOUT = {
  header: "classic" as const, footer: "columns" as const,
  productCard: { imageRatio: "square" as const, hoverImage: false, quickBuy: false, badge: "image" as const },
  grid: { desktop: 4 as const, mobile: 2 as const }, productPage: { gallery: "beside" as const, thumbnails: "beside" as const }, homepage: [...V1_HOME],
};
// Missing pre-v2 choices receive their own historical defaults, never modern template defaults.
const v1SettingsSchema = z.object({
  version: z.literal(1),
  colors: z.record(z.string(), z.string()).refine((colors) => Object.keys(colors).every((key) => Object.hasOwn(V1_COLORS, key)), "Unknown historical colour token."),
  typography: z.object({
    heading: z.enum(["system", "modern", "editorial"]).default("system"),
    body: z.enum(["system", "modern", "humanist"]).default("system"),
    scale: z.enum(["compact", "standard", "generous"]).default("standard"),
  }).strict().default({ heading: "system", body: "system", scale: "standard" }),
  cornerStyle: z.enum(["square", "subtle", "rounded"]).default("subtle"),
  density: z.enum(["compact", "comfortable", "airy"]).default("comfortable"),
  containerWidth: z.enum(["focused", "standard", "wide"]).default("wide"),
  components: z.object({
    buttons: z.enum(["solid", "soft", "outline"]).default("solid"),
    inputs: z.enum(["outlined", "filled"]).default("outlined"),
    cards: z.enum(["bordered", "elevated", "flat"]).default("bordered"),
  }).strict().default({ buttons: "solid", inputs: "outlined", cards: "bordered" }),
  layout: z.object({
    header: z.enum(["classic", "centered", "marketplace"]).default("classic"),
    footer: z.enum(["columns", "compact", "contact"]).default("columns"),
    productCard: z.object({
      imageRatio: z.enum(["square", "portrait"]).default("square"), hoverImage: z.boolean().default(false),
      quickBuy: z.boolean().default(false), badge: z.enum(["image", "price"]).default("image"),
    }).strict().default(V1_LAYOUT.productCard),
    grid: z.object({ desktop: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(4), mobile: z.union([z.literal(1), z.literal(2)]).default(2) }).strict().default(V1_LAYOUT.grid),
    productPage: z.object({ gallery: z.enum(["beside", "stacked"]).default("beside"), thumbnails: z.enum(["beside", "below"]).default("beside") }).strict().default(V1_LAYOUT.productPage),
    homepage: z.array(z.enum(V1_HOME)).length(4).refine((sections) => new Set(sections).size === 4, "Each historical section appears once.").default([...V1_HOME]),
  }).strict().default(V1_LAYOUT),
}).strict();
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Theme document must contain objects.");
  return value as RecordValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Theme document must contain lists.");
  return value;
}
function choice(value: unknown, choices: Record<string, string>): string {
  const mapped = typeof value === "string" ? choices[value] : undefined;
  if (mapped === undefined) throw new Error(`Unsupported historical theme choice: ${String(value)}.`);
  return mapped;
}

/** Before strict v2, semantic settings had no version property. */
function v1to2(doc: RecordValue): RecordValue {
  const legacy = v1SettingsSchema.parse(doc);
  const { layout, typography, components } = legacy;
  const card = layout.productCard;
  const product = layout.productPage;
  const rawColors = { ...V1_COLORS, ...legacy.colors };
  const resolveColor = (key: string, visited: string[] = []): string => {
    if (visited.includes(key) || !Object.hasOwn(rawColors, key)) throw new Error("Invalid historical colour reference.");
    const value = rawColors[key]!.trim();
    const reference = /^var\(--([a-z0-9-]+)\)$/i.exec(value)?.[1];
    if (reference) return resolveColor(reference, [...visited, key]);
    if (value.toLowerCase() === "currentcolor") return key === "foreground" ? "#000000" : resolveColor("foreground", [...visited, key]);
    return legacyColorHex(value);
  };
  const colors = Object.fromEntries(Object.keys(V1_COLORS).filter((key) => !key.startsWith("chart-")).map((key) => [key, resolveColor(key)]));
  return {
    version: 2, mode: "configured",
    legacyTypeScale: choice(typography.scale, { compact: "flat", standard: "retail", generous: "display" }),
    legacyDensity: legacy.density,
    tokens: {
      colors, typography: { heading: typography.heading, body: typography.body },
      radius: legacy.cornerStyle, containerWidth: legacy.containerWidth === "focused" ? "standard" : legacy.containerWidth,
      components: { ...components, buttons: components.buttons === "soft" ? "solid" : components.buttons },
    },
    layout: {
      header: layout.header, footer: layout.footer,
      card: card.quickBuy ? "quick" : card.imageRatio === "portrait" ? "portrait" : "standard",
      density: legacy.density === "airy" ? "comfortable" : legacy.density,
      productPage: product.gallery === "stacked" ? "stacked" : product.thumbnails === "below" ? "filmstrip" : "gallery",
    },
    sections: array(layout.homepage).map((type) => ({ id: type, type, version: 1, settings: {} })),
  };
}

/** v3 replaced independent heading and body fonts with curated pairings. */
function v2to3(doc: RecordValue): RecordValue {
  const tokens = object(doc.tokens);
  const font = object(tokens.typography);
  const pairing = font.heading === "editorial" ? (font.body === "humanist" ? "heritage" : "editorial")
    : font.body === "humanist" ? "fresh" : "retail";
  return { ...doc, version: 3, tokens: { ...tokens, typography: pairing, buttonShape: "radius" },
    layout: { ...object(doc.layout), navigation: "menu", mobileNavigation: "drawer" } };
}

const variant = (id: string) => ({ variant: id, settings: {} });

function legacySection(value: unknown): RecordValue {
  const section = object(value);
  const type = choice(section.type, { hero: "hero", collections: "collections", categories: "category-tiles", delivery: "usp-strip", rich_text: "editorial" });
  const settings = object(section.settings);
  return { ...section, type, settings: type === "editorial" ? { layout: "rich-text", ...settings } : settings };
}

/** v4 turned the layout choices into block variants of a named template. */
function v3to4(doc: RecordValue): RecordValue {
  const tokens = object(doc.tokens);
  const layout = object(doc.layout);
  const components = object(tokens.components);
  return {
    version: 4, template: "department-mall",
    tokens: {
      colors: tokens.colors, typography: tokens.typography, radius: tokens.radius, buttonShape: tokens.buttonShape,
      typeScale: doc.legacyTypeScale ?? "retail", headingCase: "sentence", density: doc.legacyDensity ?? layout.density,
      surface: choice(components.cards, { bordered: "hairline", elevated: "raised", flat: "flat" }),
      imageRatio: layout.card === "portrait" ? "portrait" : "square", imageFit: "cover", headerTone: "light",
      container: tokens.containerWidth === "standard" ? "1200" : "1440",
    },
    blocks: {
      topBar: variant("utility"),
      header: variant(choice(layout.header, { classic: "mall-search", centered: "heritage-nav", marketplace: "marketplace-search" })),
      desktopNav: variant(choice(layout.navigation, { menu: "dropdown", mega: "mega-panel", pills: "sticky-category-bar", sidebar: "departments-rail" })),
      mobileNav: variant(choice(layout.mobileNavigation, { drawer: "accordion-drawer", tabs: "bottom-tabs" })),
      card: variant(choice(layout.card, { standard: "standard", portrait: "portrait", quick: "quick-add" })),
      listing: { layout: variant("grid"), toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered" },
      product: {
        gallery: variant(choice(layout.productPage, { gallery: "classic", filmstrip: "thumbs-below", stacked: "stacked" })),
        buyBox: variant("mall"), below: ["description", "reviews", "related"],
        sticky: { phoneTop: "none", phoneBottom: "buy-bar", desktop: "none" },
      },
      footer: variant(choice(layout.footer, { columns: "minimal-columns", compact: "newsletter-grey", contact: "support-dark" })),
    },
    pages: { home: array(doc.sections).map(legacySection) },
  };
}

/** v5 separated a listing's arrangement from its facets and made the navigation source explicit. */
function v4to5(doc: RecordValue): RecordValue {
  const blocks = object(doc.blocks);
  const listing = object(blocks.listing);
  const layout = object(listing.layout);
  const layoutSettings = object(layout.settings);
  // v4's sidebar/bar layouts combined arrangement and facets; v5 separated them.
  const filterStyle = layout.variant === "shelves" ? "bar-dropdowns" : layout.variant === "bar-drawer" ? "drawer" : "sidebar-dense";
  const filters = listing.filters ?? { style: filterStyle, openByDefault: filterStyle.startsWith("sidebar") };
  const { facets: _facets, facetsOpen: _facetsOpen, ...settings } = layoutSettings;
  return { ...doc, version: 5, blocks: {
    ...blocks, navigation: blocks.navigation ?? { source: "tree+menu", maxTopItems: 8, linkBudget: 150 },
    listing: { ...listing, layout: { ...layout, variant: layout.variant === "sidebar-grid" || layout.variant === "bar-drawer" ? "grid" : layout.variant, settings }, filters },
  } };
}

/** v6 materialized template-only page chrome, retired options that never rendered, and added brand and home mode. */
function v5to6(doc: RecordValue): RecordValue {
  const blocks = object(doc.blocks);
  const listing = object(blocks.listing);
  const filters = object(listing.filters);
  const product = object(blocks.product);
  const sticky = object(product.sticky);
  const template = String(doc.template);
  const chrome: Record<string, RecordValue> = {
    boutique: { surface: "page", band: "inline" },
    "heritage-editorial": { gutter: "flush" },
    "fashion-value": { phoneBar: "bottom" },
    "spec-catalogue": { band: "beside-filters" },
    "rounded-tech": { phoneBanner: false },
    marketplace: { searchLayout: "list", phoneBar: "split-sheet" },
    "mass-retail": { searchLayout: "list", phoneBar: "pill-row", maxColumns: 4 },
    "showcase-landing": { links: "tabs" },
  };
  const retire = (block: unknown): RecordValue => {
    const { subBrandRow: _subBrandRow, trendingQueries: _trendingQueries, ...settings } = object(object(block).settings);
    return { ...object(block), settings };
  };
  const pages = object(doc.pages);
  const home = array(pages.home).map((value) => {
    const section = object(value);
    if (section.type !== "deal-block") return section;
    const { endsAt: _endsAt, ...settings } = object(section.settings);
    return { ...section, settings };
  });
  return {
    ...doc,
    version: 6,
    brand: doc.brand ?? { logo: null, logoWidth: 180, footerLogo: null, favicon: null },
    blocks: {
      ...blocks,
      ...Object.fromEntries(["topBar", "header", "desktopNav", "mobileNav", "card", "footer"].map((slot) => [slot, retire(blocks[slot])])),
      listing: {
        searchLayout: "same", descriptionPlacement: "below", surface: "muted", gutter: "inset", band: "standard",
        phoneBar: "standard", links: "chips", phoneBanner: true, maxColumns: null, ...chrome[template], ...listing,
        layout: retire(listing.layout),
        filters: { searchPlacement: template === "spec-catalogue" ? "drawer" : "same", ruled: template === "fashion-value", ...filters },
      },
      product: {
        ...product, gallery: retire(product.gallery), buyBox: retire(product.buyBox),
        below: array(product.below).filter((id) => id !== "questions"),
        sticky: { ...sticky, desktop: sticky.desktop === "info-column" || sticky.desktop === "side-rail" ? "none" : sticky.desktop },
      },
    },
    pages: { ...pages, home, homeMode: pages.homeMode ?? { kind: "sections" } },
  };
}

/** v7 added landing pages. */
function v6to7(doc: RecordValue): RecordValue {
  return { ...doc, version: 7, pages: { ...object(doc.pages), landing: {} } };
}

/** v8 added page templates (sections around the product, listing, cart and CMS pages), empty. */
function v7to8(doc: RecordValue): RecordValue {
  const empty = () => ({ sections: [], main: 0 });
  return {
    ...doc,
    version: 8,
    pages: { ...object(doc.pages), templates: { product: empty(), collection: empty(), cart: empty(), page: empty() } },
  };
}

const THEME_UPGRADES: Record<number, (document: RecordValue) => RecordValue> = {
  1: v1to2, 2: v2to3, 3: v3to4, 4: v4to5, 5: v5to6, 6: v6to7, 7: v7to8,
};

const BLOCK_SLOTS = ["topBar", "header", "desktopNav", "mobileNav", "card", "footer"] as const;

/**
 * Settings an upgraded document never stored take today's defaults; stored
 * values win. Variants and section types the registries no longer know stay
 * as stored, so the strict parse rejects them rather than guessing.
 */
function withCurrentDefaults(doc: RecordValue): RecordValue {
  const fill = (block: unknown, defaults: unknown): RecordValue => {
    const value = object(block);
    return defaults === undefined ? value : { ...value, settings: { ...structuredClone(defaults) as RecordValue, ...object(value.settings) } };
  };
  const blockDefaults = (slot: keyof typeof STOREFRONT_BLOCK_REGISTRY, block: unknown) =>
    (STOREFRONT_BLOCK_REGISTRY[slot] as Record<string, { defaults: unknown } | undefined>)[String(object(block).variant)]?.defaults;
  const section = (value: unknown): RecordValue => {
    const each = object(value);
    // Editorial settings are one of several layouts: only the stored layout's own fields apply.
    if (each.type === "editorial") return each;
    return fill(each, (STOREFRONT_SECTION_REGISTRY as Record<string, { defaults: unknown } | undefined>)[String(each.type)]?.defaults);
  };
  const blocks = object(doc.blocks);
  const listing = object(blocks.listing);
  const product = object(blocks.product);
  const pages = object(doc.pages);
  return {
    ...doc,
    blocks: {
      ...blocks,
      ...Object.fromEntries(BLOCK_SLOTS.map((slot) => [slot, fill(blocks[slot], blockDefaults(slot, blocks[slot]))])),
      listing: { ...listing, layout: fill(listing.layout, blockDefaults("listing", listing.layout)) },
      product: {
        ...product,
        gallery: fill(product.gallery, blockDefaults("gallery", product.gallery)),
        buyBox: fill(product.buyBox, blockDefaults("buyBox", product.buyBox)),
      },
    },
    pages: {
      ...pages,
      home: array(pages.home).map(section),
      landing: Object.fromEntries(Object.entries(object(pages.landing)).map(([slug, page]) => [
        slug, { ...object(page), sections: array(object(page).sections).map(section) },
      ])),
      templates: Object.fromEntries(Object.entries(object(pages.templates)).map(([kind, template]) => [
        kind, { ...object(template), sections: array(object(template).sections).map(section) },
      ])),
    },
  };
}

/** The stored document converted to `currentVersion` (a copy; the input is never changed). */
export function upgradeThemeDocumentSteps(value: unknown, currentVersion: number): unknown {
  let doc = object(structuredClone(value));
  if (doc.version === undefined) {
    if ("colors" in doc) doc.version = 1;
    else if (Object.keys(doc).length > 0 && Object.keys(doc).every((key) => Object.hasOwn(V1_COLORS, key))) doc = { version: 1, colors: doc };
  }
  if (!Number.isInteger(doc.version) || Number(doc.version) < 1 || Number(doc.version) > currentVersion) throw new Error("Unsupported theme document version.");
  if (doc.version === currentVersion) return doc;
  while (doc.version !== currentVersion) {
    const step = THEME_UPGRADES[Number(doc.version)];
    if (!step) throw new Error("Missing theme document upgrade step.");
    doc = step(doc);
  }
  return withCurrentDefaults(doc);
}

/** CSS Color 4 conversions: https://www.w3.org/TR/css-color-4/#color-conversion-code */
function legacyColorHex(value: string): string {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map((part) => part + part).join("")}`;
  if (hex === "white") return "#ffffff";
  if (hex === "black") return "#000000";
  if (hex === "transparent") return "#ffffff";
  // ponytail: pre-v2 alpha colours flatten over white; retain alpha tokens if the current schema ever supports transparency.
  if (/^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/.test(hex)) {
    const full = hex.length === 5 ? [...hex.slice(1)].map((part) => part + part).join("") : hex.slice(1);
    const alpha = parseInt(full.slice(6), 16) / 255;
    return `#${[0, 2, 4].map((at) => Math.round(parseInt(full.slice(at, at + 2), 16) * alpha + 255 * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
  }
  const match = /^([a-z]+)\(([-+0-9.%\s,/]+)\)$/.exec(hex);
  if (!match) throw new Error("Unsupported historical theme colour.");
  const [, kind, input] = match;
  const parts = input!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) throw new Error("Invalid historical theme colour.");
  const number = (index: number, percentScale = 1) => Number(parts[index]?.replace("%", "")) * (parts[index]?.endsWith("%") ? percentScale / 100 : 1);
  const gamma = (channel: number) => 255 * (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055);
  let rgb: number[];
  if (kind === "rgb" || kind === "rgba") rgb = [0, 1, 2].map((index) => number(index, 255));
  else if (kind === "hsl" || kind === "hsla") {
    const [h, s, l] = [number(0) / 360, number(1), number(2)];
    const a = s! * Math.min(l!, 1 - l!);
    rgb = [0, 8, 4].map((offset) => { const k = ((offset + h! * 12) % 12 + 12) % 12; return 255 * (l! - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); });
  } else if (kind === "oklch" || kind === "oklab") {
    const light = number(0);
    const a = kind === "oklch" ? number(1, 0.4) * Math.cos(number(2) * Math.PI / 180) : number(1, 0.4);
    const b = kind === "oklch" ? number(1, 0.4) * Math.sin(number(2) * Math.PI / 180) : number(2, 0.4);
    const l = (light + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (light - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (light - 0.0894841775 * a - 1.291485548 * b) ** 3;
    rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
      .map(gamma);
  } else if (kind === "lab" || kind === "lch") {
    const light = number(0, 100);
    const a = kind === "lch" ? number(1, 150) * Math.cos(number(2) * Math.PI / 180) : number(1, 125);
    const b = kind === "lch" ? number(1, 150) * Math.sin(number(2) * Math.PI / 180) : number(2, 125);
    const fy = (light + 16) / 116;
    const d50 = [fy + a / 500, fy, fy - b / 200].map((part, index) =>
      (part ** 3 > 216 / 24389 ? part ** 3 : (116 * part - 16) / (24389 / 27)) * [0.9642956764, 1, 0.8251046025][index]!);
    const multiply = (matrix: number[][], vector: number[]) => matrix.map((row) => row.reduce((sum, factor, index) => sum + factor * vector[index]!, 0));
    const d65 = multiply([[0.9554734215, -0.0230984549, 0.0632592432], [-0.0283697093, 1.0099953981, 0.0210414412], [0.0123140149, -0.0205076493, 1.3303659262]], d50);
    rgb = multiply([[12831 / 3959, -329 / 214, -1974 / 3959], [-851781 / 878810, 1648619 / 878810, 36519 / 878810], [705 / 12673, -2585 / 12673, 705 / 667]], d65).map(gamma);
  } else throw new Error("Unsupported historical theme colour function.");
  const alpha = parts.length > 3 ? Math.max(0, Math.min(1, number(3))) : 1;
  if (!rgb.every(Number.isFinite) || !Number.isFinite(alpha)) throw new Error("Invalid historical theme colour.");
  return `#${rgb.map((channel) => Math.round(Math.max(0, Math.min(255, channel)) * alpha + 255 * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}
