/**
 * Every gallery entry, derived from the theme registry itself
 * (`@scalius/shared/storefront-theme`): each template on each page kind,
 * each section type with each closed choice its schema allows, each block
 * variant with its settings, the listing and product composites, the tokens
 * and palettes, the app surfaces, the page kinds and the Bangla and RTL
 * presences. Each entry is a theme document plus the fixture scenario its
 * page reads, and the region the audit scopes to (`focus`).
 *
 * Nothing here renders: the real pages do, with the fixture API (`api.ts`).
 */
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_BLOCK_REGISTRY,
  STOREFRONT_PRODUCT_MODULES,
  STOREFRONT_PRODUCT_STICKY,
  STOREFRONT_LISTING_TOOLBAR,
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_TYPES,
  STOREFRONT_TEMPLATE_IDS,
  STOREFRONT_THEME_PALETTES,
  STOREFRONT_THEME_PALETTE_KEYS,
  storefrontBlockDefault,
  storefrontNavigationSchema,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  storefrontThemeBlocksSchema,
  storefrontThemeDocumentSchema,
  storefrontThemeTokensSchema,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontTemplateId,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { ARABIC_TEXT, BANGLA_LONG, type ProductScenario } from "./fixtures";
import { SECTION_CONTENT } from "./section-content";
import { settingVariants, settingChoices, settingWith, type SettingsSchema } from "./variants";

export type GalleryPage = "home" | "landing" | "product" | "category" | "collection" | "brand" | "search" | "cart" | "page";

/** The part of the page an entry is about: axe and the harness checks look only here. */
export interface GalleryFocus {
  include: string[];
  exclude?: string[];
}

export interface GalleryScenario {
  product?: ProductScenario;
  /** The page's presence: `bn` (the root speaks Bangla) or `ar` (an Arabic, RTL subfolder). */
  locale?: "bn" | "ar";
  /** The listing's results: a large catalogue (default), none, or a few. */
  listing?: "large" | "empty" | "small";
  /** App sections and product blocks draw something. */
  apps?: boolean;
  /** `localStorage` the browser starts with (a saved cart); the quality audit seeds it before the page loads. */
  storage?: Record<string, string>;
  /** An app draws blocks at the checkout targets (the layout lists the `checkout` page). */
  checkoutBlocks?: boolean;
  /** The header has the merchant's logo. */
  logo?: boolean;
}

/** A click the audit makes before it checks (a closed drawer has nothing to check). */
export interface GalleryInteraction {
  click: string;
  /** Only below this viewport width (phones and tablets). */
  maxWidth?: number;
}

export interface GalleryEntry {
  id: string;
  family: string;
  title: string;
  page: GalleryPage;
  theme: StorefrontThemeDocument;
  focus: GalleryFocus;
  scenario: GalleryScenario;
  interact?: GalleryInteraction[];
}

const WHOLE_PAGE: GalleryFocus = { include: ["body"] };
const MAIN: GalleryFocus = { include: ["#main-content"] };
const CHROME: GalleryFocus = { include: ["body"], exclude: ["#main-content", "footer"] };
const FOOTER: GalleryFocus = { include: ["footer"] };
const sectionFocus = (id: string): GalleryFocus => ({ include: [`[data-section-id="${id}"]`] });
const OPEN_MENU: GalleryInteraction = { click: "#mobile-menu-toggle", maxWidth: 1024 };

export function entryId(...parts: string[]): string {
  return parts
    .join("--")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function clone(theme: StorefrontThemeDocument): StorefrontThemeDocument {
  return structuredClone(theme) as StorefrontThemeDocument;
}

const ANNOUNCEMENT = { text: "Free delivery inside Dhaka on orders over ৳3,000", link: "/delivery" };
const FOOTER_WORDS = {
  tagline: "Handwoven sarees and genuine electronics, delivered across Bangladesh.",
  about: "Nakshi Bazar started as one stall in New Market in 2009.\n\nToday we ship to all 64 districts from our warehouse in Tejgaon, with cash on delivery and official warranty.",
  copyright: "Nakshi Bazar Limited",
};

/** A section of the type with the fixture content and these settings on top. */
export function contentSection(type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}): StorefrontSection {
  const base = storefrontSectionDefault(type, id);
  return { ...base, settings: { ...base.settings, ...SECTION_CONTENT[type].settings, ...settings } } as StorefrontSection;
}

/** The sections a block entry shows on the home page under the header. */
const HOME_SHOWCASE = (): StorefrontSection[] => [
  contentSection("hero", "hero"),
  contentSection("category-tiles", "tiles"),
  contentSection("product-rail", "rail"),
];

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/** A template's own section, with the fixture content wherever the template leaves it empty. */
function filledSection(section: StorefrontSection): StorefrontSection {
  if (section.type === "app") return section;
  const content = SECTION_CONTENT[section.type].settings;
  const current = section.settings as Record<string, unknown>;
  // Editorial settings are one shape per layout: fill only that shape's keys.
  const settings = { ...current };
  for (const [key, value] of Object.entries(content)) {
    if (section.type === "editorial" && !(key in current)) continue;
    if (isEmpty(current[key])) settings[key] = value;
  }
  const filled = { ...section, settings } as StorefrontSection;
  return STOREFRONT_SECTION_REGISTRY[section.type].schema.safeParse(filled).success ? filled : section;
}

/** A template's document with the store's content in its sections and words in its bars. */
export function templateWithContent(id: StorefrontTemplateId): StorefrontThemeDocument {
  const theme = storefrontTemplateTheme(id);
  theme.pages.home = theme.pages.home.map(filledSection);
  if (theme.blocks.topBar.variant !== "none") theme.blocks.topBar = { ...theme.blocks.topBar, settings: { ...theme.blocks.topBar.settings, ...ANNOUNCEMENT } } as typeof theme.blocks.topBar;
  theme.blocks.footer = { ...theme.blocks.footer, settings: { ...theme.blocks.footer.settings, ...FOOTER_WORDS } } as typeof theme.blocks.footer;
  return theme;
}

/** The default theme (Department mall) with content: the base every non-template entry varies. */
export function baseTheme(): StorefrontThemeDocument {
  const theme = templateWithContent("department-mall");
  theme.pages.home = HOME_SHOWCASE();
  return theme;
}

function withHome(theme: StorefrontThemeDocument, home: StorefrontSection[]): StorefrontThemeDocument {
  const next = clone(theme);
  next.pages.home = home;
  return next;
}

const TECH_TEMPLATES = new Set<string>(["spec-catalogue", "rounded-tech", "marketplace", "mass-retail", "department-mall", "daily-essentials"]);

// ─── Families ─────────────────────────────────────────────────────────────

function templateEntries(): GalleryEntry[] {
  const pages: Array<{ page: GalleryPage; label: string }> = [
    { page: "home", label: "home" },
    { page: "product", label: "product" },
    { page: "category", label: "category" },
    { page: "cart", label: "cart" },
    { page: "page", label: "cms page" },
  ];
  return STOREFRONT_TEMPLATE_IDS.flatMap((template) =>
    pages.map(({ page, label }) => ({
      id: entryId("template", template, label),
      family: `template:${template}`,
      title: `Template ${template}, ${label}`,
      page,
      theme: templateWithContent(template),
      focus: WHOLE_PAGE,
      scenario: { product: TECH_TEMPLATES.has(template) ? "electronics" : "fashion", logo: true },
    })),
  );
}

function sectionEntries(): GalleryEntry[] {
  const entries: GalleryEntry[] = [];
  for (const type of STOREFRONT_SECTION_TYPES) {
    const spec = STOREFRONT_SECTION_REGISTRY[type];
    const base = contentSection(type, "gallery").settings;
    const variants = settingVariants(spec.settings as SettingsSchema, base);
    for (const [name, alternative] of Object.entries(SECTION_CONTENT[type].alternatives ?? {})) {
      const settings = { ...base, ...alternative };
      if (spec.settings.safeParse(settings).success) variants.push({ label: name, settings });
    }
    for (const variant of variants) {
      const section = { ...storefrontSectionDefault(type, "gallery"), settings: variant.settings } as StorefrontSection;
      // Banners in a row need a neighbour with the same layout to share it.
      const home = type === "banner" && ["two-up", "four-up"].includes(String((variant.settings as Record<string, unknown>).layout))
        ? [section, { ...section, id: "gallery-2" } as StorefrontSection]
        : [section];
      entries.push({
        id: entryId("section", type, variant.label),
        family: `section:${type}`,
        title: `${type}, ${variant.label}`,
        page: "home",
        theme: withHome(baseTheme(), home),
        focus: sectionFocus("gallery"),
        scenario: {},
      });
    }
  }
  return entries;
}

/** Settings a block variant shows its content with (the bars' words, the footer's). */
function blockContent(slot: StorefrontBlockSlot, settings: Record<string, unknown>): Record<string, unknown> {
  if (slot === "topBar" && "text" in settings) return { ...settings, ...ANNOUNCEMENT };
  if (slot === "footer") return { ...settings, ...FOOTER_WORDS };
  return settings;
}

const SLOT_PAGE: Record<StorefrontBlockSlot, { page: GalleryPage; focus: GalleryFocus; interact?: GalleryInteraction[] }> = {
  topBar: { page: "home", focus: CHROME },
  header: { page: "home", focus: CHROME },
  desktopNav: { page: "home", focus: CHROME },
  mobileNav: { page: "home", focus: CHROME, interact: [OPEN_MENU] },
  card: { page: "category", focus: MAIN },
  listing: { page: "category", focus: MAIN },
  gallery: { page: "product", focus: MAIN },
  buyBox: { page: "product", focus: MAIN },
  footer: { page: "home", focus: FOOTER },
};

function withBlock(theme: StorefrontThemeDocument, slot: StorefrontBlockSlot, value: { variant: string; settings: Record<string, unknown> }): StorefrontThemeDocument {
  const next = clone(theme);
  const blocks = next.blocks as unknown as Record<string, unknown> & { listing: { layout: unknown }; product: { gallery: unknown; buyBox: unknown } };
  if (slot === "listing") blocks.listing.layout = value;
  else if (slot === "gallery") blocks.product.gallery = value;
  else if (slot === "buyBox") blocks.product.buyBox = value;
  else blocks[slot] = value;
  // A variant that needs another block's variant (`quick-grid` needs the quick-add card) gets it.
  for (const condition of storefrontVariantSpec(slot, value.variant).requires) {
    if ("block" in condition && condition.variants.length > 0) {
      blocks[condition.block] = storefrontBlockDefault(condition.block as StorefrontBlockSlot, condition.variants[0]!);
    }
  }
  return next;
}

function blockEntries(): GalleryEntry[] {
  const entries: GalleryEntry[] = [];
  for (const slot of Object.keys(STOREFRONT_BLOCK_REGISTRY) as StorefrontBlockSlot[]) {
    for (const variant of Object.keys(STOREFRONT_BLOCK_REGISTRY[slot])) {
      const spec = storefrontVariantSpec(slot, variant);
      const base = blockContent(slot, storefrontBlockDefault(slot, variant).settings);
      const { page, focus, interact } = SLOT_PAGE[slot];
      for (const setting of settingVariants(spec.settings, base)) {
        entries.push({
          id: entryId("block", slot, variant, setting.label),
          family: `block:${slot}`,
          title: `${slot} ${variant}${setting.label === "default" ? "" : `, ${setting.label}`}`,
          page,
          theme: withBlock(baseTheme(), slot, { variant, settings: setting.settings }),
          focus,
          scenario: { product: slot === "buyBox" && variant === "spec" ? "electronics" : "fashion" },
          ...(interact ? { interact } : {}),
        });
      }
    }
  }
  return entries;
}

function listingEntries(): GalleryEntry[] {
  const listingSchema = (storefrontThemeBlocksSchema as unknown as { shape: { listing: SettingsSchema } }).shape.listing;
  const base = baseTheme();
  const entries: GalleryEntry[] = [];
  for (const { path, values } of settingChoices(listingSchema)) {
    if (path.startsWith("layout.")) continue;
    for (const value of values) {
      const listing = settingWith(base.blocks.listing, path, value);
      if (JSON.stringify(listing) === JSON.stringify(base.blocks.listing) || !listingSchema.safeParse(listing).success) continue;
      const theme = clone(base);
      theme.blocks.listing = listing;
      entries.push({
        id: entryId("listing", `${path}=${String(value)}`),
        family: "listing",
        title: `Listing ${path} = ${String(value)}`,
        page: path === "searchLayout" ? "search" : "category",
        theme,
        focus: MAIN,
        scenario: {},
      });
    }
  }
  const toolbars: Array<[string, string[]]> = [["all", Object.keys(STOREFRONT_LISTING_TOOLBAR)], ["none", []]];
  for (const [label, toolbar] of toolbars) {
    const theme = clone(base);
    theme.blocks.listing = { ...theme.blocks.listing, toolbar: toolbar as typeof theme.blocks.listing.toolbar };
    entries.push({ id: entryId("listing", `toolbar=${label}`), family: "listing", title: `Listing toolbar: ${label}`, page: "category", theme, focus: MAIN, scenario: {} });
  }
  for (const listing of ["empty", "small"] as const) {
    entries.push({ id: entryId("listing", `results=${listing}`), family: "listing", title: `Listing with ${listing} results`, page: listing === "empty" ? "search" : "category", theme: clone(base), focus: MAIN, scenario: { listing } });
  }
  for (const page of ["collection", "brand", "search"] as const) {
    entries.push({ id: entryId("listing", `page=${page}`), family: "listing", title: `Listing page: ${page}`, page, theme: clone(base), focus: MAIN, scenario: {} });
  }
  return entries;
}

function navigationEntries(): GalleryEntry[] {
  const base = baseTheme();
  const entries: GalleryEntry[] = [];
  for (const variant of settingVariants(storefrontNavigationSchema, base.blocks.navigation)) {
    const theme = clone(base);
    theme.blocks.navigation = variant.settings;
    entries.push({ id: entryId("navigation", variant.label), family: "block:navigation", title: `Navigation ${variant.label}`, page: "home", theme, focus: CHROME, scenario: {} });
  }
  const theme = clone(base);
  theme.blocks.navigation = { ...theme.blocks.navigation, maxTopItems: 18, linkBudget: 150 };
  entries.push({ id: entryId("navigation", "largest-budget"), family: "block:navigation", title: "Navigation, 18 top items and 150 links", page: "home", theme, focus: CHROME, scenario: {} });
  return entries;
}

function productEntries(): GalleryEntry[] {
  const base = baseTheme();
  const entries: GalleryEntry[] = [];
  const modules = Object.keys(STOREFRONT_PRODUCT_MODULES) as Array<keyof typeof STOREFRONT_PRODUCT_MODULES>;
  for (const module of modules) {
    const theme = clone(base);
    theme.blocks.product = { ...theme.blocks.product, below: [module] };
    entries.push({ id: entryId("product", "module", module), family: "product:module", title: `Product module ${module}`, page: "product", theme, focus: MAIN, scenario: { product: "electronics" } });
  }
  const all = clone(base);
  all.blocks.product = { ...all.blocks.product, below: modules };
  entries.push({ id: entryId("product", "module", "all"), family: "product:module", title: "Every product module", page: "product", theme: all, focus: MAIN, scenario: { product: "electronics" } });
  for (const [position, values] of Object.entries(STOREFRONT_PRODUCT_STICKY)) {
    for (const value of values) {
      const theme = clone(base);
      theme.blocks.product = { ...theme.blocks.product, sticky: { ...theme.blocks.product.sticky, [position]: value } };
      entries.push({ id: entryId("product", "sticky", `${position}=${value}`), family: "product:sticky", title: `Product sticky ${position} = ${value}`, page: "product", theme, focus: WHOLE_PAGE, scenario: { product: "fashion" } });
    }
  }
  for (const product of ["fashion", "electronics", "sold-out", "no-image", "bangla", "simple"] as const) {
    entries.push({ id: entryId("product", "state", product), family: "product:state", title: `Product page, ${product}`, page: "product", theme: clone(base), focus: MAIN, scenario: { product } });
  }
  return entries;
}

function tokenEntries(): GalleryEntry[] {
  const base = baseTheme();
  base.pages.home = [
    contentSection("hero", "hero"),
    contentSection("category-tiles", "tiles"),
    contentSection("product-rail", "rail"),
    contentSection("banner", "banner"),
    contentSection("newsletter", "newsletter"),
  ];
  const entries: GalleryEntry[] = [];
  for (const variant of settingVariants(storefrontThemeTokensSchema, base.tokens)) {
    if (variant.label === "default") continue;
    const theme = clone(base);
    theme.tokens = variant.settings;
    entries.push({ id: entryId("token", variant.label), family: `token:${variant.label.split("=")[0]}`, title: `Token ${variant.label}`, page: "home", theme, focus: WHOLE_PAGE, scenario: {} });
  }
  for (const palette of STOREFRONT_THEME_PALETTE_KEYS) {
    for (const headerTone of ["light", "dark", "brand"] as const) {
      const theme = clone(base);
      theme.tokens = { ...theme.tokens, colors: { ...STOREFRONT_THEME_PALETTES[palette] }, headerTone };
      // A palette may not pass every pair with every header tone: such a document is not saveable.
      if (!storefrontThemeDocumentSchema.safeParse(theme).success) continue;
      entries.push({ id: entryId("palette", palette, `header=${headerTone}`), family: `palette:${palette}`, title: `Palette ${palette}, ${headerTone} header`, page: "home", theme, focus: WHOLE_PAGE, scenario: {} });
    }
  }
  return entries;
}

/** A saved cart with two lines, so the checkout steps (and the targets apps draw at) are visible. */
const GALLERY_CART = JSON.stringify({
  items: {
    "line:v3:prod_0:variant:var_0:p:none": { id: "prod_0", slug: "handwoven-jamdani-saree", name: "Handwoven Dhakai Jamdani Saree", price: 6500, quantity: 1, variantId: "var_0", propertiesHash: "none", options: [{ name: "Colour", value: "Bottle green" }] },
    "line:v3:prod_1:variant:var_1:p:none": { id: "prod_1", slug: "cotton-panjabi", name: "Cotton Panjabi", price: 1490, quantity: 2, variantId: "var_1", propertiesHash: "none" },
  },
});

function appEntries(): GalleryEntry[] {
  const base = baseTheme();
  const home = clone(base);
  home.pages.home = [
    contentSection("hero", "hero"),
    { id: "app-greeting", type: "app", version: 1, settings: { app: "acme.hello/greeting", values: { heading: "Eid Mubarak from Nakshi Bazar", text: "Orders placed before the 28th arrive before Eid." } } },
    contentSection("product-rail", "rail"),
  ];
  const product = clone(base);
  product.blocks.product = {
    ...product.blocks.product,
    apps: [
      { id: "wishlist", app: "acme.wishlist/button", values: { label: "Save to wishlist" } },
      { id: "note", app: "acme.hello/note", values: { note: "Packed with care in Dhaka." } },
    ],
  };
  return [
    { id: entryId("app", "checkout-blocks"), family: "app:checkout-block", title: "App blocks at the checkout targets (cart page)", page: "cart", theme: clone(base), focus: MAIN, scenario: { checkoutBlocks: true, storage: { "cart:v3": GALLERY_CART } } },
    { id: entryId("app", "section"), family: "app:section", title: "App section on the home page", page: "home", theme: home, focus: { include: ['[data-section-id="app-greeting"]'] }, scenario: { apps: true } },
    { id: entryId("app", "section", "empty"), family: "app:section", title: "App section that drew nothing", page: "home", theme: home, focus: WHOLE_PAGE, scenario: { apps: false } },
    { id: entryId("app", "product-blocks"), family: "app:product-block", title: "App product blocks (buy box and below)", page: "product", theme: product, focus: MAIN, scenario: { apps: true, product: "fashion" } },
  ];
}

function pageEntries(): GalleryEntry[] {
  const base = baseTheme();
  const templated = clone(base);
  const around = (id: string, heading: string): StorefrontSection => contentSection("editorial", id, { layout: "rich-text", heading, body: "Free delivery inside Dhaka on orders over ৳3,000. Cash on delivery everywhere." });
  for (const kind of ["product", "collection", "cart", "page"] as const) {
    templated.pages.templates[kind] = { sections: [around(`${kind}-above`, "Before the page"), contentSection("product-rail", `${kind}-rail`, { title: "You may also like" })], main: 1 };
  }
  const landing = clone(base);
  landing.pages.landing = {
    "eid-sale": {
      title: "Eid sale 2026",
      description: "Up to 40% off sarees, panjabi and phones until Chand Raat.",
      sections: [contentSection("hero", "landing-hero"), contentSection("deal-block", "landing-deal"), contentSection("faq", "landing-faq")],
    },
  };
  const productHome = clone(base);
  return [
    { id: entryId("page", "cart"), family: "page:cart", title: "Cart page (empty cart)", page: "cart", theme: clone(base), focus: MAIN, scenario: {} },
    { id: entryId("page", "cms"), family: "page:cms", title: "CMS page", page: "page", theme: clone(base), focus: MAIN, scenario: {} },
    { id: entryId("page", "landing"), family: "page:landing", title: "Landing page with sections", page: "landing", theme: landing, focus: MAIN, scenario: {} },
    { id: entryId("page", "logo"), family: "page:home", title: "Home with the merchant's logo", page: "home", theme: productHome, focus: CHROME, scenario: { logo: true } },
    ...(["product", "category", "cart", "page"] as const).map((page) => ({
      id: entryId("page", "template-sections", page),
      family: "page:template-sections",
      title: `Template sections around the ${page} page`,
      page,
      theme: templated,
      focus: MAIN,
      scenario: { product: "fashion" as const },
    })),
  ];
}

function localeEntries(): GalleryEntry[] {
  const base = baseTheme();
  const rtl = clone(base);
  rtl.pages.home = [contentSection("hero", "hero", { slides: [{ image: "banner-eid", focalPoint: { x: 50, y: 50 }, alt: ARABIC_TEXT, heading: ARABIC_TEXT, buttonLabel: "تسوق الآن", link: "/collections/col-eid" }] }), contentSection("category-tiles", "tiles"), contentSection("product-rail", "rail"), contentSection("faq", "faq")];
  const bangla = clone(base);
  bangla.pages.home = [contentSection("hero", "hero", { slides: [{ image: "banner-boishakh", focalPoint: { x: 50, y: 50 }, alt: BANGLA_LONG, heading: BANGLA_LONG, buttonLabel: "এখনই কিনুন", link: "/collections/col-bangla" }] }), contentSection("category-tiles", "tiles"), contentSection("product-rail", "rail"), contentSection("newsletter", "newsletter")];
  const pages: GalleryPage[] = ["home", "product", "category", "cart"];
  return pages.flatMap((page) => [
    { id: entryId("locale", "bn", page), family: "locale:bn", title: `Bangla store, ${page}`, page, theme: bangla, focus: WHOLE_PAGE, scenario: { locale: "bn" as const, product: "bangla" as const } },
    { id: entryId("locale", "ar-rtl", page), family: "locale:rtl", title: `Arabic (RTL) presence, ${page}`, page, theme: rtl, focus: WHOLE_PAGE, scenario: { locale: "ar" as const, product: "fashion" as const } },
  ]);
}

let cached: GalleryEntry[] | null = null;

/** Every entry, in family order; ids are unique and stable. */
export function galleryEntries(): GalleryEntry[] {
  if (cached) return cached;
  const entries = [
    ...templateEntries(),
    ...sectionEntries(),
    ...blockEntries(),
    ...navigationEntries(),
    ...listingEntries(),
    ...productEntries(),
    ...tokenEntries(),
    ...appEntries(),
    ...pageEntries(),
    ...localeEntries(),
  ];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Duplicate gallery entry id: ${entry.id}`);
    seen.add(entry.id);
    // The storefront renders the default theme for an invalid document: an entry must be saveable.
    const parsed = storefrontThemeDocumentSchema.safeParse(entry.theme);
    if (!parsed.success) {
      throw new Error(`Gallery entry ${entry.id} has an invalid theme: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
    }
  }
  cached = entries;
  return entries;
}

export function galleryEntry(id: string): GalleryEntry | null {
  return galleryEntries().find((entry) => entry.id === id) ?? null;
}

/** The theme a page kind reads it with (default theme for its own blocks). */
export const GALLERY_DEFAULT_THEME = DEFAULT_STOREFRONT_THEME;
