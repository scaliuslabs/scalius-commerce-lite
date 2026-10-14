// @vitest-environment node
/**
 * The homepage section library, render-only: every section type the
 * storefront renders x every density x a tiny and a large store renders the
 * real HomepageSections (Astro container API through a Vite dev server in
 * middleware mode) and checks what each section promises: data-driven
 * structure, nothing for missing data, one LCP candidate (the hero), rails
 * that scroll with CSS scroll-snap, fixed-ratio photos, long Bangla copy
 * that can wrap, and unique ids. Layout, contrast and CLS on real viewports
 * need a browser.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_DENSITIES,
  buildStorefrontThemeTokens,
  STOREFRONT_SECTION_RENDERERS,
  STOREFRONT_SECTION_TYPES,
  storefrontTemplateTheme,
  storefrontSectionDefault,
  storefrontSectionRenderer,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { requestThemeFor } from "@/lib/storefront-theme-context";
import {
  homepageLeadSection,
  homepageRenderUnits,
  homepageSectionRenders,
  type HomepageContent,
} from "@/lib/homepage-sections";
import type { HomepageMetaobject } from "@/lib/api/storefront";
import { SHELF_CARD_SIZES, productCardImageSizes, productGridSpec } from "@/lib/product-card-layout";
import { capPhoneSizesDensity, scaleSizes } from "@/lib/responsive-image";

// ─── Harness ──────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

interface Container {
  renderToString(component: unknown, options: { props?: object; locals?: object; request?: Request }): Promise<string>;
}

let server: ViteDevServer;
let container: Container;
let HomepageSections: unknown;
let requestRuntime: typeof import("@/lib/api/runtime").requestRuntime;
let ExtensionHost: typeof import("@/lib/extensions/host").ExtensionHost;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "homepage-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0home-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0home-test:") ? VIRTUAL_MODULES[id.slice("\0home-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  const reactRenderer = (await server.ssrLoadModule("@astrojs/react/server.js")).default;
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({
    name: "@astrojs/react",
    renderer: reactRenderer,
  });
  HomepageSections = (await server.ssrLoadModule("/src/components/homepage/HomepageSections.astro")).default;
  requestRuntime = (await server.ssrLoadModule("/src/lib/api/runtime.ts")).requestRuntime;
  ExtensionHost = (await server.ssrLoadModule("/src/lib/extensions/host.ts")).ExtensionHost;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

let window = new Window();
afterEach(async () => {
  const previous = window;
  window = new Window();
  await previous.happyDOM.close();
});
const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function themeWith(density: (typeof STOREFRONT_DENSITIES)[number]): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  theme.tokens.density = density;
  return theme;
}

async function render(
  sections: StorefrontSection[],
  content: HomepageContent,
  theme: StorefrontThemeDocument = DEFAULT_STOREFRONT_THEME,
): Promise<Document> {
  const leadSectionId = homepageLeadSection(sections, content)?.id ?? null;
  const html = await container.renderToString(HomepageSections, {
    props: { sections, content, leadSectionId, currencySymbol: "৳", currencyCode: "BDT" },
    locals: { storefrontTheme: Promise.resolve(requestThemeFor(theme)) },
    request: new Request("https://shop.test/"),
  });
  return parse(html);
}

function duplicateIds(page: Document): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const element of Array.from(page.querySelectorAll("[id]"))) {
    if (seen.has(element.id)) duplicates.add(element.id);
    seen.add(element.id);
  }
  return [...duplicates];
}

// ─── Fixtures: a tiny store and a large one ───────────────────────────────

const BANGLA = "হাতে বোনা জামদানি শাড়ি সুতি ও রেশমের মিশ্রণে তৈরি নকশিকাঁথা ফোঁড়ের পাড় সহ উৎসবের জন্য বিশেষ সংস্করণ";
const image = (name: string) => `https://cdn.shop.test/media/${name}.jpg/1080.webp`;

function card(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `p${index}`,
    name: index % 5 === 0 ? `${BANGLA} ${index}` : `Product ${index}`,
    slug: `product-${index}`,
    price: 1200,
    discountType: index % 3 === 0 ? "percentage" : null,
    discountPercentage: index % 3 === 0 ? 10 : 0,
    discountAmount: 0,
    discountedPrice: index % 3 === 0 ? 1080 : 1200,
    priceVaries: false,
    availableForSale: index % 7 !== 0,
    freeDelivery: false,
    categoryId: "cat-sarees",
    hasVariants: index % 4 === 0,
    // Some products have no photo: the card keeps its box with a letter.
    imageUrl: index % 6 === 0 ? null : image(`p${index}`),
    imageMediaId: null,
    imageAlt: null,
    secondaryImageUrl: null,
    ...overrides,
  };
}

/** A hero slide as the theme stores it: media ids, words and a link. */
const slide = (image: string, options: { phoneImage?: string; heading?: string; link?: string | null } = {}) => ({
  image,
  ...(options.phoneImage ? { phoneImage: options.phoneImage } : {}),
  focalPoint: { x: 50, y: 50 },
  alt: `Banner ${image}`,
  ...(options.heading ? { heading: options.heading, text: "Supporting words", buttonLabel: "Shop now" } : {}),
  link: options.link !== undefined ? options.link : options.heading ? "/collections/eid" : null,
});

/** The hero's slides: three computer images, two of them with their own phone image. */
const HERO_SLIDES = [
  slide("d1", { phoneImage: "m1", heading: BANGLA }),
  slide("d2", { phoneImage: "m2" }),
  slide("d3"),
];

const media = (id: string) => ({ id, url: image(id), alt: `Photo ${id}`, width: 1600, height: 1000 });

/** A content type with every field kind the section draws (and ones it must not). */
const METAOBJECT_STORES: HomepageMetaobject = {
  id: "mo-stores",
  name: "Store locations",
  entries: [
    {
      handle: "dhanmondi",
      title: "Dhanmondi showroom",
      fields: [
        { key: "address", name: "Address", type: "multi_line_text", value: "House 12, Road 5\nDhanmondi, Dhaka <b>1205</b>" },
        { key: "website", name: "Website", type: "url", value: "https://nakshibazar.example/dhanmondi" },
        { key: "map", name: "Map", type: "url", value: "/pages/stores" },
        { key: "evil", name: "Evil", type: "url", value: "javascript:alert(1)" },
        { key: "brand", name: "Brand colour", type: "color", value: "#1f5f4a" },
        { key: "deposit", name: "Deposit", type: "money", value: 1250 },
        { key: "parking", name: "Parking", type: "boolean", value: true },
        { key: "opened", name: "Opened", type: "date", value: "2019-04-14" },
        { key: "photo", name: "Photo", type: "media_reference", value: "m-story" },
        { key: "gone", name: "Missing photo", type: "media_reference", value: "m-missing" },
        { key: "services", name: "Services", type: "list.single_line_text", value: ["Alterations", "Gift wrap"] },
        { key: "extra", name: "Extra photos", type: "list.media_reference", value: ["m-tile-1", "m-tile-2"] },
        { key: "raw", name: "Raw", type: "json", value: "{\"a\":1}" },
        { key: "product", name: "Product", type: "product_reference", value: "prod_1" },
      ],
    },
    { handle: "uttara", title: BANGLA, fields: [{ key: "address", name: "Address", type: "single_line_text", value: "Sector 7, Uttara" }] },
    { handle: "online", title: "Online only", fields: [{ key: "json", name: "Raw", type: "json", value: "{}" }] },
  ],
};

function store(size: "tiny" | "large"): HomepageContent {
  const count = size === "tiny" ? 3 : 36;
  const products = Array.from({ length: count }, (_, index) => card(index + 1));
  const categories = Array.from({ length: size === "tiny" ? 2 : 12 }, (_, index) => ({
    id: `cat-${index}`,
    name: index === 1 ? BANGLA : `Category ${index}`,
    slug: `category-${index}`,
    description: null,
    imageUrl: index % 3 === 0 ? null : image(`cat-${index}`),
    canonicalPath: null,
  }));
  const list = (key: string, extra: Record<string, unknown> = {}) => [key, { key, products, category: null, collection: null, ...extra }] as const;
  const collections = [
    { id: "col-grid", name: "Best sellers", presentation: "grid", config: { maxProducts: 8, title: "", subtitle: "" }, categories: [], products: products.slice(0, 8), featuredProduct: null },
    { id: "col-rail", name: "New in", presentation: "carousel", config: { maxProducts: 12, title: "", subtitle: "" }, categories: [], products: products.slice(0, 12), featuredProduct: null },
  ];
  // The tiny store's hero has one photo (its first slide's, without a phone image); the large one all of them.
  const heroMedia = size === "tiny" ? ["d1"] : ["d1", "d2", "d3", "m1", "m2"];
  return {
    collections: new Map(collections.map((collection) => [collection.id, collection])) as unknown as HomepageContent["collections"],
    categories: new Map(categories.map((category) => [category.id, category])),
    homeProduct: null,
    deliveryFacts: [
      { kind: "delivery", title: "Delivery ৳60 in Dhaka", detail: "৳120 outside Dhaka" },
      { kind: "cod", title: "Cash on delivery", detail: "Pay when it arrives" },
    ],
    lists: new Map([
      list("newest"),
      list("on-sale"),
      list("popular"),
      list("category:cat-sarees", { category: { id: "cat-sarees", name: "Sarees", slug: "sarees", canonicalPath: null } }),
      list("collection:col-eid", { collection: { id: "col-eid", title: "Eid edit" } }),
    ]) as unknown as HomepageContent["lists"],
    media: new Map([...heroMedia, "m-banner", "m-banner-2", "m-look", "m-story", "m-side-1", "m-side-2", "m-card-1", "m-card-2", "m-tile-1", "m-tile-2", "m-tile-3"]
      .map((id) => [id, media(id)])),
    brands: Array.from({ length: size === "tiny" ? 2 : 6 }, (_, index) => ({
      id: `brd_${index}`,
      name: index === 1 ? BANGLA : `Brand ${index}`,
      slug: `brand-${index}`,
      canonicalPath: null,
      logo: index % 2 === 0 ? { mediaId: `m-logo-${index}`, url: image(`logo-${index}`), alt: "", width: 240, height: 120 } : null,
    })),
    promotionEnds: new Map([["promo-eid", new Date(Date.now() + 86_400_000 * 2).toISOString()]]),
    metaobjects: new Map([["mo-stores", METAOBJECT_STORES]]),
  };
}

const EMPTY: HomepageContent = {
  collections: new Map(),
  categories: new Map(),
  homeProduct: null,
  deliveryFacts: [],
  lists: new Map(),
  media: new Map(),
  brands: [],
  promotionEnds: new Map(),
};

const section = <Type extends StorefrontSectionType>(type: Type, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;
/** A hero with the fixture slides. */
const hero = (settings: Record<string, unknown> = {}) => section("hero", "hero", { slides: HERO_SLIDES, ...settings });
/** Every fixture category, in the large store's order (the tiny store has the first two). */
const CATEGORY_IDS = Array.from({ length: 12 }, (_, index) => `cat-${index}`);
const tiles = (settings: Record<string, unknown> = {}) => section("category-tiles", "tiles", { categoryIds: CATEGORY_IDS, ...settings });
const COLLECTION_IDS = ["col-grid", "col-rail"];

/** Every renderable section type with settings that read the fixtures' data. */
const EVERY_SECTION: StorefrontSection[] = [
  hero({ layout: "contained-banners", sideBanners: [{ mediaId: "m-side-1", alt: "Side one", href: "/sale" }, { mediaId: "m-side-2", alt: "", href: null }] }),
  section("usp-strip", "usp"),
  tiles({ style: "round" }),
  section("collections", "collections", { collectionIds: COLLECTION_IDS }),
  section("product-rail", "rail", { title: "", source: { kind: "newest" }, limit: 12 }),
  section("product-grid", "grid", { title: BANGLA, source: { kind: "category", categoryId: "cat-sarees" }, columns: 4, rows: 2 }),
  section("deal-block", "deal", { title: "Flash sale", source: { kind: "on-sale" }, promotionId: "promo-eid" }),
  section("product-tabs", "tabs", { title: "", limit: 8, tabs: [
    { label: "", source: { kind: "newest" } },
    { label: BANGLA, source: { kind: "popular" } },
    { label: "Sarees", source: { kind: "category", categoryId: "cat-sarees" } },
  ] }),
  section("lookbook", "look", { title: "Eid looks", mediaId: "m-look", source: { kind: "collection", collectionId: "col-eid" } }),
  section("shop-by", "shop-by", { title: "Shop by occasion", cards: [
    { mediaId: "m-card-1", title: "Eid", href: "/collections/eid" },
    { mediaId: "m-card-2", title: BANGLA, href: "/categories/sarees" },
    { mediaId: "m-missing", title: "Gone", href: "/gone" },
  ] }),
  section("banner-mosaic", "mosaic", { tiles: [
    { mediaId: "m-tile-1", alt: "Eid sale", href: "/sale" },
    { mediaId: "m-tile-2", alt: "", href: "/new" },
    { mediaId: "m-tile-3", alt: "Sarees", href: null },
  ] }),
  section("brand-wall", "brands", { title: "", style: "rail" }),
  section("recently-viewed", "recent", { title: "" }),
  section("banner", "banner-1", { layout: "two-up", heading: "Eid sale", text: BANGLA, mediaId: "m-banner", cta: { label: "Shop", href: "/sale" } }),
  section("banner", "banner-2", { layout: "two-up", heading: "", text: "", mediaId: "m-banner-2", cta: null }),
  { id: "story", type: "editorial", version: 1, settings: { layout: "image-with-text", heading: "Our story", body: BANGLA, mediaId: "m-story", imageSide: "end" } },
  section("faq", "faq", { heading: "", items: [{ question: "Do you deliver outside Dhaka?", answer: BANGLA }] }),
  section("utility-cards", "utility", { cards: [{ title: "Track order", text: "Where is my parcel", href: "/track-order" }, { title: "Stores", text: "", href: "/pages/stores" }] }),
  section("endless-grid", "endless", { title: "", pageSize: 24 }),
  section("metaobjects", "meta", { heading: "", definitionId: "mo-stores", layout: "list", limit: 12 }),
  section("seo-text", "seo", { heading: "About us", body: "## Sarees in Bangladesh\nHandwoven.\n\nMore text." }),
  section("newsletter", "news", { heading: "", text: "", email: "optional", whatsapp: true }),
];

// ─── Tests ────────────────────────────────────────────────────────────────

/** What ProductCard asks for a photo in `slot`: 88% of it for a contained photo, phones capped at 2x. */
const cardSizes = (slot: string, theme = DEFAULT_STOREFRONT_THEME) =>
  capPhoneSizesDensity(scaleSizes(slot, requestThemeFor(theme).layout.productCard.imageFit === "contain" ? 0.88 : 1));

describe("homepage section library", () => {
  it("covers every renderable section type", () => {
    expect(new Set(EVERY_SECTION.map((each) => each.type))).toEqual(new Set(STOREFRONT_SECTION_RENDERERS));
    for (const type of STOREFRONT_SECTION_TYPES) {
      if (!(STOREFRONT_SECTION_RENDERERS as readonly string[]).includes(type)) {
        expect(homepageSectionRenders(storefrontSectionDefault(type, "x"), store("large"))).toBe(false);
      }
    }
  });

  describe.each(STOREFRONT_DENSITIES)("%s density", (density) => {
    it.each(["tiny", "large"] as const)("renders every section with data on a %s store", async (size) => {
      const content = store(size);
      const page = await render(EVERY_SECTION, content, themeWith(density));
      expect(duplicateIds(page)).toEqual([]);
      const expected = homepageRenderUnits(EVERY_SECTION, content)
        .flatMap((unit) => (unit.kind === "banners" ? unit.sections : [unit.section]).map((each) => each.type));
      expect(Array.from(page.querySelectorAll("[data-home-section]")).map((node) => node.getAttribute("data-home-section")))
        .toEqual(expected);
      // Only the hero asks for high priority, and everything below it loads lazily.
      for (const img of Array.from(page.querySelectorAll('img[fetchpriority="high"]'))) {
        expect(img.closest('[data-home-section="hero"]')).not.toBeNull();
      }
      for (const img of Array.from(page.querySelectorAll("img"))) {
        if (img.closest('[data-home-section="hero"]')) continue;
        expect(img.getAttribute("loading"), img.outerHTML.slice(0, 120)).toBe("lazy");
        // Every photo box has intrinsic dimensions or a fixed-ratio frame.
        expect(img.getAttribute("width")).toBeTruthy();
        expect(img.getAttribute("height")).toBeTruthy();
      }
      // Every product grid sits in its container frame.
      for (const grid of Array.from(page.querySelectorAll(".product-grid"))) {
        expect(grid.parentElement!.classList.contains("product-grid-frame")).toBe(true);
      }
    });
  });

  it("renders nothing for sections without data", async () => {
    const page = await render(EVERY_SECTION, EMPTY);
    // Only the merchant's own words remain: a banner with a heading (the
    // photo-only one is gone), the story, the FAQ, the cards and the copy,
    // plus the recently-viewed island, which ships hidden and fills itself
    // from the buyer's own browser, and the newsletter signup (no data).
    expect(Array.from(page.querySelectorAll("[data-home-section]")).map((node) => node.getAttribute("data-section-id")))
      .toEqual(["recent", "banner-1", "story", "faq", "utility", "seo", "news"].sort((a, b) =>
        EVERY_SECTION.findIndex((each) => each.id === a) - EVERY_SECTION.findIndex((each) => each.id === b)));
    expect(page.querySelector("[data-recently-viewed]")!.hasAttribute("hidden")).toBe(true);
    // No placeholders: no product grid, no rail, no hero, no empty list.
    expect(page.querySelector(".product-grid, [data-product-rail], [data-hero-layout], .desktop-carousel")).toBeNull();
    // Words alone never lead: there is no photo to load early.
    expect(homepageLeadSection(EVERY_SECTION, EMPTY)).toBeNull();
  });

  it("keeps one banner and one category section while putting categories first on phones", async () => {
    const page = await render([
      hero({ layout: "full-bleed", phonePlacement: "after-categories" }),
      tiles({ style: "square" }),
    ], store("large"));
    const units = [...page.querySelectorAll("[data-home-render-unit]")];
    expect(units.map((unit) => unit.getAttribute("data-section-id"))).toEqual(["hero", "tiles"]);
    expect(units.map((unit) => unit.getAttribute("data-phone-order"))).toEqual(["1", "0"]);
    expect(page.querySelectorAll('[data-section-id="hero"]')).toHaveLength(1);
    expect(page.querySelectorAll('[data-section-id="tiles"]')).toHaveLength(1);
    expect(page.querySelector('.desktop-carousel img')?.getAttribute("fetchpriority")).toBe("high");
    expect(page.querySelector('.mobile-carousel img')?.getAttribute("fetchpriority")).toBe("auto");
  });

  it.each(["full-bleed", "contained-banners", "split", "full-screen", "wide-editorial"] as const)(
    "renders the %s hero with the first banner as the only high-priority image",
    async (layout) => {
      const page = await render([hero({ layout })], store("large"));
      const high = Array.from(page.querySelectorAll('img[fetchpriority="high"]'));
      expect(high.length).toBeGreaterThan(0);
      expect(high.length).toBeLessThanOrEqual(2); // one per viewport
      if (layout === "split") {
        expect(page.querySelectorAll('[data-hero-layout="split"] .hero-picture')).toHaveLength(3);
      } else {
        expect(page.querySelector(".desktop-carousel")).not.toBeNull();
        const rounded = ["rounded-xl", "rounded-2xl"].some((each) => page.querySelector(".desktop-carousel")!.classList.contains(each));
        expect(rounded).toBe(layout === "contained-banners" || layout === "wide-editorial");
      }
      // The slide's supporting text shows in every layout, beside its heading.
      expect(text(page.querySelector('[data-home-section="hero"]'))).toContain("Supporting words");
    },
  );

  it("shows side banners only beside a contained hero, and only with their images", async () => {
    const content = store("large");
    const sides = [{ mediaId: "m-side-1", alt: "Side one", href: "/sale" }, { mediaId: "missing", alt: "", href: null }];
    const page = await render([hero({ layout: "contained-banners", sideBanners: sides })], content);
    const banners = page.querySelectorAll("[data-hero-side-banners] img");
    expect(banners).toHaveLength(1);
    expect(banners[0]!.getAttribute("loading")).toBe("lazy");
    expect(page.querySelector('[data-hero-side-banners] a[href="/sale"]')).not.toBeNull();
    const fullBleed = await render([hero({ layout: "full-bleed", sideBanners: sides })], content);
    expect(fullBleed.querySelector("[data-hero-side-banners]")).toBeNull();
  });

  it("scrolls rails with CSS scroll-snap and shows short lists as a grid", async () => {
    const large = await render([section("product-rail", "rail", { title: "", source: { kind: "newest" }, limit: 12 })], store("large"));
    const track = large.querySelector("[data-product-rail-track]")!;
    expect(track.className).toContain("snap-x");
    expect(track.className).toContain("overflow-x-auto");
    const items = Array.from(track.children);
    expect(items).toHaveLength(12);
    expect(items.every((item) => item.className.includes("snap-start"))).toBe(true);
    expect(track.querySelector("img[sizes]")!.getAttribute("sizes")).toBe(cardSizes(SHELF_CARD_SIZES));
    // The title says what the list is; "View all" goes to the full listing.
    expect(text(large.querySelector("h2"))).toBe("New arrivals");
    expect(large.querySelector('a[href="/search"]')).not.toBeNull();
    // Three products are not a rail.
    const tiny = await render([section("product-rail", "rail", { title: "", source: { kind: "popular" }, limit: 12 })], store("tiny"));
    expect(tiny.querySelector("[data-product-rail-track]")).toBeNull();
    expect(tiny.querySelectorAll(".product-grid > *")).toHaveLength(3);
    // Popular has no listing to link to.
    expect(tiny.querySelector('a[href^="/search"]')).toBeNull();
  });

  it("puts one or two products in a capped two-column grid, and shows rail arrows only when the cards overflow", async () => {
    // One or two cards are never stretched across the row or left beside empty tracks.
    const two = await render([section("product-grid", "grid", { title: "", source: { kind: "newest" }, columns: 2, rows: 1 })], store("large"));
    expect(two.querySelectorAll(".product-grid > *")).toHaveLength(2);
    expect(two.querySelector(".product-grid-frame[data-sparse]")).not.toBeNull();
    expect(two.querySelector(".home-grid-capped")).toBeNull();
    const full = await render([section("product-grid", "grid", { title: "", source: { kind: "newest" }, columns: 5, rows: 2 })], store("large"));
    expect(full.querySelector("[data-sparse]")).toBeNull();
    const pair = await render([section("product-rail", "rail", { title: "", source: { kind: "newest" }, limit: 2 })], store("large"));
    expect(pair.querySelector("[data-product-rail-track]")).toBeNull();
    expect(pair.querySelector(".product-grid-frame[data-sparse]")).not.toBeNull();
    // Three or more are the normal grid.
    const tiny = await render([section("product-rail", "rail", { title: "", source: { kind: "popular" }, limit: 12 })], store("tiny"));
    expect(tiny.querySelector("[data-sparse]")).toBeNull();
    // Arrows: none for four cards (they fit from 1024px), xl-only hidden for five, always for twelve.
    const arrows = async (limit: number) => (await render([section("product-rail", "rail", { title: "", source: { kind: "newest" }, limit })], store("large"))).querySelector(".home-rail-arrows");
    expect(await arrows(4)).not.toBeNull();
    expect((await arrows(4))!.hasAttribute("data-fits-lg")).toBe(true);
    expect((await arrows(5))!.hasAttribute("data-fits-lg")).toBe(false);
    expect((await arrows(5))!.hasAttribute("data-fits-xl")).toBe(true);
    expect((await arrows(12))!.hasAttribute("data-fits-xl")).toBe(false);
    // Every rail track is marked for focus reveal.
    const rail = await render([section("product-rail", "rail", { title: "", source: { kind: "newest" }, limit: 12 })], store("large"));
    expect(rail.querySelector("[data-product-rail-track]")!.hasAttribute("data-h-rail")).toBe(true);
  });

  it("sizes compact collection carousels as shelves without changing collection presentations", async () => {
    // The compact shelf is the section's setting, in any template.
    const compact = [section("collections", "collections", { carousel: "compact", collectionIds: COLLECTION_IDS })];
    for (const theme of [storefrontTemplateTheme("marketplace"), DEFAULT_STOREFRONT_THEME]) {
      const rounded = await render(compact, store("large"), theme);
      expect(rounded.querySelectorAll(".product-grid")).toHaveLength(1);
      expect(rounded.querySelectorAll("[data-product-rail-track] .home-shelf-item")).toHaveLength(12);
    }

    const classic = await render([section("collections", "collections", { collectionIds: COLLECTION_IDS })], store("large"), storefrontTemplateTheme("marketplace"));
    expect(classic.querySelectorAll("[data-product-rail-track] .home-shelf-item")).toHaveLength(0);
    expect(classic.querySelector("[data-product-rail-track] > div")!.className).toContain("w-[72%]");
  });

  it("draws small and scrolling round categories from the section's style, in any template", async () => {
    const rounded = await render([tiles({ style: "round-small" })], store("large"));
    const roundedTile = rounded.querySelector('a[href="/categories/category-1"]')!;
    expect(roundedTile.querySelector(".cat-round-small")).not.toBeNull();
    expect(roundedTile.querySelector("img")!.getAttribute("sizes")).toBe("56px");

    const classic = await render([tiles({ style: "round" })], store("large"), storefrontTemplateTheme("marketplace"));
    const classicTile = classic.querySelector('a[href="/categories/category-1"]')!;
    expect(classicTile.querySelector(".cat-round-photo")).not.toBeNull();
    expect(classicTile.querySelector(".cat-round-small")).toBeNull();
    expect(classicTile.querySelector("img")!.getAttribute("sizes")).toBe("(max-width: 639px) 30vw, 112px");

    const retail = await render([tiles({ style: "round-row" })], store("large"));
    const retailRow = retail.querySelector("[data-home-section='category-tiles'] ul")!;
    // One scrolling row on phones (a grid from 640px); the plain round style is always a grid.
    expect(retailRow.className).toContain("cat-round-row");
    expect(classic.querySelector("[data-home-section='category-tiles'] ul")!.className).not.toContain("cat-round-row");
  });

  it("fills a product grid with columns x rows and caps its columns", async () => {
    const page = await render([section("product-grid", "grid", { title: "", source: { kind: "category", categoryId: "cat-sarees" }, columns: 5, rows: 2 })], store("large"));
    expect(page.querySelectorAll(".product-grid > *")).toHaveLength(10);
    expect(page.querySelector(".home-grid-capped")!.getAttribute("style")).toContain("--home-grid-columns: 5");
    // Card photos use the selected maximum column count.
    const { layout, theme } = requestThemeFor(DEFAULT_STOREFRONT_THEME);
    const grid = productGridSpec(layout.grid, theme.tokens.imageRatio);
    const container = buildStorefrontThemeTokens(theme)["theme-container-width"]!;
    const capped = productCardImageSizes(grid, container, "grid", "grid", 5);
    expect(page.querySelector(".product-grid img[sizes]")!.getAttribute("sizes")).toBe(cardSizes(capped, theme));
    expect(text(page.querySelector("h2"))).toBe("Sarees");
    expect(page.querySelector('a[href="/categories/sarees"]')).not.toBeNull();
  });

  it("counts a deal down only to its running promotion's end", async () => {
    const ahead = await render([section("deal-block", "deal", { title: "", source: { kind: "on-sale" }, promotionId: "promo-eid" })], store("large"));
    const countdown = ahead.querySelector("[data-deal-countdown]")!;
    expect(countdown.classList.contains("invisible")).toBe(true); // shown by the script, its box laid out already
    expect(text(countdown.querySelector("time"))).toMatch(/^(\d+d )?\d{2}:\d{2}:\d{2}$/);
    expect(ahead.querySelector('a[href="/search?hasDiscount=true"]')).not.toBeNull();
    const ended = await render(
      [section("deal-block", "deal", { title: "", source: { kind: "on-sale" }, promotionId: "promo-eid" })],
      { ...store("large"), promotionEnds: new Map([["promo-eid", "2020-01-01T00:00:00Z"]]) },
    );
    expect(ended.querySelector("[data-deal-countdown]")).toBeNull();
    expect(ended.querySelector("[data-deal-block]")).not.toBeNull();
    // A typed-in date is never a countdown: only a promotion's end is.
    const none = await render([section("deal-block", "deal", { title: "", source: { kind: "on-sale" }, promotionId: null })], store("large"));
    expect(none.querySelector("[data-deal-countdown]")).toBeNull();
    const unknown = await render([section("deal-block", "deal", { title: "", source: { kind: "on-sale" }, promotionId: "promo-gone" })], store("large"));
    expect(unknown.querySelector("[data-deal-countdown]")).toBeNull();
  });

  it("ends a lookbook with 'View more' when there is more to see", async () => {
    const page = await render([section("lookbook", "look", { title: "", mediaId: "m-look", source: { kind: "collection", collectionId: "col-eid" } })], store("large"));
    expect(page.querySelectorAll("ul > li")).toHaveLength(8);
    expect(text(page.querySelector('a[href="/collections/col-eid"]'))).toBe("View more");
    expect(page.querySelector("figure img")!.getAttribute("alt")).toBe("Photo m-look");
    expect(text(page.querySelector("figcaption h2"))).toBe("Eid edit");
    const noPhoto = await render([section("lookbook", "look", { title: "", mediaId: "gone", source: { kind: "collection", collectionId: "col-eid" } })], store("tiny"));
    expect(noPhoto.querySelector("figure")).toBeNull();
    expect(noPhoto.querySelectorAll("ul > li")).toHaveLength(3);
  });

  it("lays a square-photo lookbook out in a 1:2 split with the one product card, and a tall photo in 2:3", async () => {
    // The square photo is the section's setting, in any template.
    const source = { kind: "collection", collectionId: "col-eid" };
    const square = await render([section("lookbook", "look", { mediaId: "m-look", source, photo: "square" })], store("large"));
    // The photo fills its cell: it is the frame that is square, then the grid's height from 1024px.
    expect(square.querySelector("figure img")?.className).toContain("object-cover");
    expect(square.querySelector("figure")?.className).toContain("aspect-square");
    expect(square.querySelector("figure")!.parentElement!.className).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]");
    expect(square.querySelectorAll("figure ~ div .product-card-link, figure + div .product-card-link")).toHaveLength(7);
    expect(square.querySelector("figure ~ div .product-card-link")?.textContent).toContain("Product");
    // Every product is the one card: a heading level under the lookbook's h2, no per-site variant.
    expect(square.querySelector("figure ~ div [data-theme-component='product-card']")!.hasAttribute("data-card-variant")).toBe(false);
    expect(square.querySelector("figure ~ div .product-card-name")!.tagName).toBe("H3");
    expect(text(square.querySelector("figcaption h2"))).toBe("Eid edit");

    const tall = await render([section("lookbook", "look", { mediaId: "m-look", source })], store("large"));
    expect(tall.querySelector("figure")?.className).toContain("lg:aspect-auto");
    expect(tall.querySelector("figure")!.parentElement!.className).toContain("lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]");

    // Without its photo the lookbook is a headed grid of products.
    const noPhoto = await render([section("lookbook", "look", { mediaId: "missing", source, photo: "square" })], store("large"));
    expect(noPhoto.querySelector("figure")).toBeNull();
    expect(noPhoto.querySelector("h2")).not.toBeNull();
    expect(noPhoto.querySelectorAll("[data-theme-component='product-card']").length).toBeGreaterThan(0);
  });

  it("puts consecutive two-up banners in one row and draws text over a scrim", async () => {
    const page = await render([
      section("banner", "b1", { layout: "two-up", heading: "Eid sale", text: "", mediaId: "m-banner", cta: { label: "Shop", href: "/sale" } }),
      section("banner", "b2", { layout: "two-up", heading: "", text: "", mediaId: "m-banner-2", cta: null }),
      section("banner", "b3", { layout: "two-up", heading: "New season", text: "Colour banner", mediaId: null, cta: null }),
      section("banner", "b4", { layout: "full", heading: "", text: "", mediaId: "missing", cta: null }),
    ], store("large"));
    const rows = page.querySelectorAll("section");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelectorAll('[data-home-section="banner"]')).toHaveLength(2);
    // Words over a photo sit on a 70% black band, white on it: AA over any photo.
    const copy = rows[0]!.querySelector("h2")!.closest(".hero-copy")!;
    expect(copy.getAttribute("data-tone")).toBe("band");
    expect(copy.querySelector(".hero-copy-body")).not.toBeNull();
    // A banner without a photo is a colour banner in theme colours.
    expect(rows[1]!.querySelector("[data-home-section='banner']")!.className).toContain("bg-secondary");
  });

  it("renders editorial, FAQ, utility and SEO copy as escaped plain text", async () => {
    const page = await render([
      { id: "cols", type: "editorial", version: 1, settings: { layout: "multicolumn", heading: "Why us", columns: [{ title: "Handmade", text: "<b>By hand</b>" }, { title: "", text: "" }] } },
      { id: "quotes", type: "editorial", version: 1, settings: { layout: "testimonial", quotes: [{ quote: BANGLA, author: "Rina" }] } },
      section("faq", "faq", { heading: "", items: [{ question: "Returns?", answer: "Within 7 days." }] }),
      section("seo-text", "seo", { heading: "", body: "## Heading one\nText one.\n\nPlain paragraph." }),
    ], store("tiny"));
    expect(page.querySelectorAll('[data-section-id="cols"] li')).toHaveLength(1);
    expect(page.querySelector("b")).toBeNull();
    expect(text(page.querySelector("blockquote"))).toContain(BANGLA);
    expect(page.querySelectorAll("details summary")).toHaveLength(1);
    expect(text(page.querySelector('[data-section-id="faq"] h2'))).toBe("Questions and answers");
    expect(text(page.querySelector('[data-section-id="seo"] h3'))).toBe("Heading one");
    expect(page.querySelectorAll('[data-section-id="seo"] p')).toHaveLength(2);
  });

  it("offers the endless grid's next listing page as a real link", async () => {
    const page = await render([section("endless-grid", "endless", { title: "", pageSize: 24 })], store("large"));
    expect(page.querySelectorAll(".product-grid > *")).toHaveLength(24);
    expect(page.querySelector("[data-endless-more]")!.getAttribute("href")).toBe("/search?page=2");
    expect(text(page.querySelector("h2"))).toBe("More to explore");
  });

  it("renders the ticker as one still line: nothing moves, so nothing needs a pause", async () => {
    const page = await render([section("usp-strip", "notice", { style: "ticker", source: { kind: "custom", items: [{ title: "New branch in Sylhet", detail: "Open daily" }] } })], store("tiny"));
    expect(page.querySelector(".usp-still")!.textContent).toContain("New branch in Sylhet: Open daily");
    expect(page.querySelector('input[type="checkbox"]')).toBeNull();
    expect(page.querySelector("[aria-hidden='true'] li")).toBeNull();
  });

  it("hides the delivery-facts strip below two facts and centres one custom point", async () => {
    const one: HomepageContent = { ...store("tiny"), deliveryFacts: [{ kind: "cod", title: "Cash on delivery", detail: "Pay when it arrives" }] };
    expect(homepageSectionRenders(section("usp-strip", "usp"), one)).toBe(false);
    const single = await render([section("usp-strip", "usp", { style: "icons", source: { kind: "custom", items: [{ title: "Free returns", detail: "" }] } })], store("tiny"));
    expect(single.querySelector(".usp-single")!.textContent).toContain("Free returns");
  });

  it("keeps the photo category tiles for one category and the denser styles for two or more", async () => {
    const one: HomepageContent = { ...store("tiny"), categories: new Map([...store("tiny").categories].slice(0, 1)) };
    for (const style of ["icons", "round", "quad", "square"]) {
      expect(homepageSectionRenders(tiles({ style }), one)).toBe(false);
    }
    expect(homepageSectionRenders(tiles({ style: "photo" }), one)).toBe(true);
    const quad = await render([tiles({ style: "quad" })], store("large"));
    // Twelve categories make three cards of four.
    expect(quad.querySelectorAll("ul > li > ul")).toHaveLength(3);
    // A category without a photo shows its first letter in the same box.
    expect(text(quad.querySelector('a[href="/categories/category-0"] span'))).toBe("C");
    const square = await render([tiles({ style: "square" })], store("large"));
    expect(square.querySelectorAll('a[href^="/categories/"]')).toHaveLength(12);
    expect(square.querySelector('a[href="/categories/category-0"] .cat-square-photo')).not.toBeNull();
    expect(text(square.querySelector('a[href="/categories/category-0"] > span:last-child'))).toBe("Category 0");
  });

  it("shows photo tiles as a scrolling row on phones and a balanced grid beside it, with one monogram placeholder", async () => {
    const heritage = await render([tiles({ style: "photo-grid" })], store("large"));
    const grid = heritage.querySelector("[data-heritage-departments]")!;
    expect(grid.classList.contains("cat-photos")).toBe(true);
    expect(grid.querySelectorAll('a[href^="/categories/"]')).toHaveLength(12);
    // Twelve tiles: 3 across at 640px and 4 at 1024px, never 8 + 4.
    expect(grid.getAttribute("style")).toContain("--cols-tablet:3");
    expect(grid.getAttribute("style")).toContain("--cols-desktop:4");
    // A category without a photo shows its letter, not a blank gradient.
    expect(text(grid.querySelector('a[href="/categories/category-0"] .cat-monogram'))).toBe("C");

    const classic = await render([tiles({ style: "photo" })], store("large"), storefrontTemplateTheme("boutique"));
    expect(classic.querySelector("[data-heritage-departments]")).toBeNull();
    expect(classic.querySelector(".cat-photos")!.getAttribute("style")).toContain("--cols-desktop:4");
    const merchantRound = await render([tiles({ style: "round" })], store("large"), storefrontTemplateTheme("boutique"));
    expect(merchantRound.querySelector("[data-heritage-departments]")).toBeNull();
    // The section's title is a real heading with no stray "Explore by department" text.
    expect(text(classic.querySelector('[data-home-section="category-tiles"]'))).not.toContain("Explore by department");
  });

  it("shortens only an image-only compact phone hero so departments appear sooner", async () => {
    const fullScreen = [hero({ layout: "full-screen", phoneHeight: "compact" })];
    const heritage = DEFAULT_STOREFRONT_THEME;
    // A linked photo without words or a button still needs no full screen.
    const linkedBlank = [hero({ layout: "full-screen", phoneHeight: "compact", slides: [slide("d1", { link: "/search?q=phone" })] })];
    const imageOnly = await render(linkedBlank, store("tiny"), heritage);
    expect(imageOnly.querySelector('.mobile-carousel[data-carousel-layout="full-screen"]')!.getAttribute("style"))
      .toContain("65svh");
    expect(imageOnly.querySelector('.desktop-carousel[data-carousel-layout="full-screen"]')!.getAttribute("style"))
      .toContain("100svh");

    const promoted = await render(fullScreen, store("large"), heritage);
    expect(promoted.querySelector('.mobile-carousel[data-carousel-layout="full-screen"]')!.getAttribute("style"))
      .toContain("70svh");
    const screen = await render([hero({ layout: "full-screen" })], store("tiny"), storefrontTemplateTheme("boutique"));
    expect(screen.querySelector('.mobile-carousel[data-carousel-layout="full-screen"]')!.getAttribute("style"))
      .toContain("70svh");
  });

  it("switches product tabs without script and keeps only tabs with products", async () => {
    const tabs = EVERY_SECTION.find((each) => each.id === "tabs")!;
    const page = await render([tabs], store("large"));
    const inputs = page.querySelectorAll('input[type="radio"].home-tab-input');
    expect(inputs).toHaveLength(3);
    expect((inputs[0] as HTMLInputElement).hasAttribute("checked")).toBe(true);
    expect(page.querySelectorAll(".home-tab-panel")).toHaveLength(3);
    const labels = Array.from(page.querySelectorAll(".home-tab-label")).map(text);
    expect(labels.slice(1)).toEqual([BANGLA, "Sarees"]);
    expect(labels[0]).not.toBe(""); // an unlabelled tab is named after its source
    // A tab whose source has no products drops; one left is a plain titled row.
    const content = store("large");
    const lists = new Map(content.lists);
    lists.delete("popular");
    lists.delete("category:cat-sarees");
    const single = await render([tabs], { ...content, lists });
    expect(single.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(single.querySelectorAll(".home-tab-panel")).toHaveLength(1);
    expect(single.querySelector("h2")).not.toBeNull();
  });

  it("draws shop-by cards and mosaic tiles only for photos that exist", async () => {
    const page = await render([
      EVERY_SECTION.find((each) => each.id === "shop-by")!,
      EVERY_SECTION.find((each) => each.id === "mosaic")!,
    ], store("large"));
    const shopBy = page.querySelector('[data-home-section="shop-by"]')!;
    expect(Array.from(shopBy.querySelectorAll("li a")).map((link) => link.getAttribute("href"))).toEqual(["/collections/eid", "/categories/sarees"]);
    const mosaic = page.querySelector('[data-home-section="banner-mosaic"]')!;
    expect(mosaic.querySelectorAll("img")).toHaveLength(3);
    expect(mosaic.querySelectorAll("a")).toHaveLength(2); // the tile without a link is not a link
    expect(mosaic.querySelector('a[href="/new"]')!.getAttribute("aria-label")).toBe("Promotion 2");
  });

  it("shows a brand wall only with four brands, each linking to its brand page", async () => {
    const wall = [section("brand-wall", "brands", { title: "", style: "grid" })];
    const large = await render(wall, store("large"));
    const links = Array.from(large.querySelectorAll("[data-brand-wall] a"));
    expect(links).toHaveLength(6);
    expect(links[0]!.getAttribute("href")).toBe("/brands/brand-0");
    expect(links[0]!.querySelector("img")!.getAttribute("alt")).toBe("Brand 0");
    expect(text(links[1]!)).toBe(BANGLA);
    const tiny = await render(wall, store("tiny"));
    expect(tiny.querySelector("[data-brand-wall]")).toBeNull();
  });

  it("ships recently viewed empty and hidden, filled only from this browser", async () => {
    const page = await render([section("recently-viewed", "recent", { title: "" })], store("large"));
    const island = page.querySelector("[data-recently-viewed]")!;
    expect(island.hasAttribute("hidden")).toBe(true);
    expect(island.querySelectorAll("li")).toHaveLength(0);
    expect(page.querySelector("script")!.textContent).toContain("localStorage");
  });

  it("draws a metaobject type's entries by field type, escaped, in all three layouts", async () => {
    const list = await render([section("metaobjects", "meta", { heading: "Visit us", definitionId: "mo-stores", layout: "list", limit: 12 })], store("large"));
    const root = list.querySelector('[data-section-id="meta"]')!;
    expect(text(root.querySelector("h2"))).toBe("Visit us");
    expect(Array.from(root.querySelectorAll("h3")).map(text)).toEqual(["Dhanmondi showroom", BANGLA, "Online only"]);
    const first = root.querySelector("li")!;
    const rows = new Map(Array.from(first.querySelectorAll("dl > div")).map((row) => [text(row.querySelector("dt")), row.querySelector("dd")!]));
    // Text escapes and keeps its breaks; nothing becomes markup.
    expect(rows.get("Address")!.innerHTML).toContain("&lt;b&gt;1205&lt;/b&gt;");
    expect(first.querySelector("b")).toBeNull();
    expect(rows.get("Address")!.textContent).toContain("\n");
    // Links: https opens safely elsewhere, a store path stays, anything else is text.
    const site = rows.get("Website")!.querySelector("a")!;
    expect(site.getAttribute("href")).toBe("https://nakshibazar.example/dhanmondi");
    expect(site.getAttribute("rel")).toBe("noopener noreferrer");
    expect(rows.get("Map")!.querySelector("a")!.getAttribute("href")).toBe("/pages/stores");
    expect(rows.get("Map")!.querySelector("a")!.hasAttribute("rel")).toBe(false);
    expect(rows.get("Evil")!.querySelector("a")).toBeNull();
    expect(first.querySelector('a[href^="javascript"]')).toBeNull();
    expect(text(rows.get("Brand colour")!)).toBe("#1f5f4a");
    expect(rows.get("Brand colour")!.querySelector("[style]")!.getAttribute("style")).toContain("#1f5f4a");
    expect(text(rows.get("Deposit")!)).toBe("৳1,250");
    expect(text(rows.get("Parking")!)).toBe("Yes");
    expect(text(rows.get("Opened")!)).toBe("14 April 2019");
    expect(text(rows.get("Services")!)).toBe("Alterations, Gift wrap");
    expect(rows.get("Photo")!.querySelector("img")!.getAttribute("alt")).toBe("Photo m-story");
    expect(rows.get("Extra photos")!.querySelectorAll("img")).toHaveLength(2);
    // A photo that did not resolve, JSON and references are not shown.
    for (const name of ["Missing photo", "Raw", "Product"]) expect(rows.has(name), name).toBe(false);

    const grid = await render([section("metaobjects", "meta", { heading: "", definitionId: "mo-stores", layout: "grid", limit: 12 })], store("large"));
    expect(text(grid.querySelector("h2"))).toBe("Store locations"); // the type's name when the section has no heading
    expect(grid.querySelectorAll('[data-section-id="meta"] ul > li')).toHaveLength(3);
    // The card leads with its first single photo; the photo is not repeated as a row.
    expect(grid.querySelector('[data-section-id="meta"] li > img')!.getAttribute("alt")).toBe("Photo m-story");

    const accordion = await render([section("metaobjects", "meta", { heading: "", definitionId: "mo-stores", layout: "accordion", limit: 12 })], store("large"));
    expect(accordion.querySelectorAll("details")).toHaveLength(2);
    expect(text(accordion.querySelector("details summary"))).toBe("Dhanmondi showroom");
    // A question with one answer field shows the answer alone; an entry with nothing to open is a plain row.
    expect(accordion.querySelectorAll("details")[1]!.querySelector("dl")).toBeNull();
    expect(text(accordion.querySelectorAll("details")[1]!.querySelector("div"))).toBe("Sector 7, Uttara");
    expect(text(accordion.querySelector('[data-section-id="meta"] p'))).toBe("Online only");
  });

  it("limits the entries and renders nothing for an unset, unknown or empty type", async () => {
    const one = await render([section("metaobjects", "meta", { definitionId: "mo-stores", layout: "list", limit: 1 })], store("large"));
    expect(one.querySelectorAll('[data-section-id="meta"] h3')).toHaveLength(1);
    for (const definitionId of ["", "mo-gone"]) {
      const page = await render([section("metaobjects", "meta", { definitionId, layout: "list", limit: 12 })], store("large"));
      expect(page.querySelector('[data-section-id="meta"]'), definitionId).toBeNull();
    }
    const content = store("large");
    const empty: HomepageContent = { ...content, metaobjects: new Map([["mo-stores", { id: "mo-stores", name: "Stores", entries: [] }]]) };
    expect((await render([section("metaobjects", "meta", { definitionId: "mo-stores" })], empty)).querySelector('[data-section-id="meta"]')).toBeNull();
  });

  it("maps each registry type to its own renderer", () => {
    for (const type of STOREFRONT_SECTION_RENDERERS) {
      expect(storefrontSectionRenderer(storefrontSectionDefault(type, "x"))).toBe(type);
    }
  });
});

describe("homepage sections from the theme's own data", () => {
  const sourceSet = (node: Element | null) => node?.getAttribute("srcset") ?? node?.getAttribute("data-srcset") ?? "";

  it("draws the hero's own slides: computer images on computers, phone images on phones", async () => {
    const page = await render([hero({ layout: "full-bleed" })], store("large"));
    const desktop = Array.from(page.querySelectorAll(".desktop-carousel [data-slide-index]"));
    const phone = Array.from(page.querySelectorAll(".mobile-carousel [data-slide-index]"));
    expect(desktop).toHaveLength(3);
    expect(phone).toHaveLength(3);
    expect(desktop.map((each) => sourceSet(each.querySelector("source")))).toEqual([
      expect.stringContaining("/media/d1.jpg/"),
      expect.stringContaining("/media/d2.jpg/"),
      expect.stringContaining("/media/d3.jpg/"),
    ]);
    // A slide without a phone image shows its computer image on phones.
    expect(phone.map((each) => sourceSet(each.querySelector("source")))).toEqual([
      expect.stringContaining("/media/m1.jpg/"),
      expect.stringContaining("/media/m2.jpg/"),
      expect.stringContaining("/media/d3.jpg/"),
    ]);
    expect(desktop[0]!.querySelector("source")!.getAttribute("media")).toBe("(min-width: 768px)");
    expect(phone[0]!.querySelector("source")!.getAttribute("media")).toBe("(max-width: 767px)");
    // The alt text is the slide's; the words and the link are drawn over it.
    expect(desktop[0]!.querySelector("img")!.getAttribute("alt")).toBe("Banner d1");
    expect(desktop[0]!.querySelector("a")!.getAttribute("href")).toBe("/collections/eid");
    expect(text(desktop[0])).toContain(BANGLA);
    expect(desktop[1]!.querySelector("a")).toBeNull();
  });

  it("crops a phone slide around its phone focal point, on its own image or the computer one", async () => {
    const slides = [
      { image: "d1", phoneImage: "m1", focalPoint: { x: 10, y: 20 }, phoneFocalPoint: { x: 80, y: 30 }, alt: "One", link: null },
      { image: "d2", phoneImage: "deleted", focalPoint: { x: 40, y: 60 }, phoneFocalPoint: { x: 25, y: 75 }, alt: "Two", link: null },
      { image: "d3", focalPoint: { x: 55, y: 45 }, alt: "Three", link: null },
    ];
    const page = await render([hero({ layout: "contained-banners", slides })], store("large"));
    const position = (selector: string) => Array.from(page.querySelectorAll(`${selector} [data-slide-index] img`))
      .map((img) => img.getAttribute("style"));
    expect(position(".desktop-carousel")).toEqual([
      "object-position: 10% 20%;",
      "object-position: 40% 60%;",
      "object-position: 55% 45%;",
    ]);
    expect(position(".mobile-carousel")).toEqual([
      "object-position: 80% 30%;",
      "object-position: 25% 75%;",
      "object-position: 55% 45%;",
    ]);
    const phoneSources = Array.from(page.querySelectorAll(".mobile-carousel [data-slide-index] source")).map(sourceSet);
    expect(phoneSources[1]).toContain("/media/d2.jpg/");
  });

  it("skips slides whose image did not resolve and renders no hero without one", async () => {
    const tiny = await render([hero({ layout: "full-bleed" })], store("tiny"));
    expect(tiny.querySelectorAll(".desktop-carousel [data-slide-index]")).toHaveLength(1);
    expect(tiny.querySelectorAll(".mobile-carousel [data-slide-index]")).toHaveLength(1);
    expect(sourceSet(tiny.querySelector(".mobile-carousel source"))).toContain("/media/d1.jpg/");
    const none = await render([hero({ layout: "full-bleed", slides: [slide("gone")] })], store("large"));
    expect(none.querySelector('[data-home-section="hero"]')).toBeNull();
  });

  it("draws the category tiles the section names, in its order, under its title", async () => {
    const named = tiles({ style: "square", title: "", categoryIds: ["cat-4", "cat-missing", "cat-2"] });
    const page = await render([named], store("large"));
    expect(Array.from(page.querySelectorAll('[data-home-section="category-tiles"] a')).map((link) => link.getAttribute("href")))
      .toEqual(["/categories/category-4", "/categories/category-2"]);
    expect(text(page.querySelector('[data-home-section="category-tiles"] h2'))).toBe("Shop by category");
    const titled = await render([tiles({ style: "photo", title: "Departments", categoryIds: ["cat-2"] })], store("large"));
    const heading = titled.querySelector('[data-home-section="category-tiles"] h2')!;
    expect(text(heading)).toBe("Departments");
    expect(titled.querySelector('[data-home-section="category-tiles"] section')!.getAttribute("aria-labelledby")).toBe(heading.id);
    // Two sections, two sets of tiles, unique ids.
    const twice = await render([
      tiles({ style: "photo", categoryIds: ["cat-1"] }),
      { ...tiles({ style: "round", categoryIds: ["cat-3", "cat-5"] }), id: "more-tiles" },
    ], store("large"));
    expect(duplicateIds(twice)).toEqual([]);
    expect(twice.querySelectorAll('[data-home-section="category-tiles"]')).toHaveLength(2);
  });

  it("shows the collections the section names, in its order, and the newest products without one", async () => {
    const page = await render([section("collections", "collections", { collectionIds: ["col-rail", "col-missing", "col-grid"] })], store("large"));
    const headings = Array.from(page.querySelectorAll('[data-home-section="collections"] h2')).map(text);
    expect(headings).toEqual(["New in", "Best sellers"]);
    expect(page.querySelector('a[href="/collections/col-rail"]')).not.toBeNull();

    const fallback = await render([section("collections", "collections", { collectionIds: ["col-missing"] })], store("large"));
    expect(Array.from(fallback.querySelectorAll('[data-home-section="collections"] h2')).map(text)).toEqual(["New arrivals"]);
    expect(fallback.querySelectorAll(".product-grid > *")).toHaveLength(8);
    expect(fallback.querySelector('a[href^="/collections/"]')).toBeNull();
  });

  it("shows the store's delivery facts in a delivery-facts strip and nowhere without one", async () => {
    const withStrip = await render([section("usp-strip", "usp"), section("product-rail", "rail", { source: { kind: "newest" } })], store("large"));
    expect(text(withStrip.querySelector('[data-home-section="usp-strip"]'))).toContain("Cash on delivery");
    const without = await render([section("product-rail", "rail", { source: { kind: "newest" } })], store("large"));
    expect(text(without.body)).not.toContain("Cash on delivery");
    // A strip without facts to show renders nothing.
    expect((await render([section("usp-strip", "usp")], { ...store("large"), deliveryFacts: [] })).querySelector("[data-home-section]")).toBeNull();
  });
});

describe("app sections", () => {
  const app = (id: string, key = "acme.hello/greeting") =>
    ({ id, type: "app", version: 1, settings: { app: key, values: {} } }) as StorefrontSection;
  /** The component data the API gave these sections (acme.hello's greeting). */
  const given = (content: HomepageContent, ids: string[]): HomepageContent => ({
    ...content,
    apps: new Map(ids.map((sectionId) => [sectionId, {
      sectionId,
      component: { pluginId: "acme.hello", type: "greeting", values: {}, media: [], lists: [] },
    }])),
  });
  const GREETING_LAYOUT = { currency: { code: "BDT", symbol: "৳" }, appExtensions: [{
    pluginId: "acme.hello", version: "1.0.0", source: "bundled", release: "a".repeat(64),
    sections: ["greeting"], sectionSettings: { greeting: [] }, skins: [], blocks: [], islands: [], stylesheet: false, connect: [],
  }] } as unknown as import("@/lib/api/storefront").LayoutData;

  async function renderWith(sections: StorefrontSection[], content: HomepageContent, extra: Record<string, unknown>): Promise<Document> {
    const html = await container.renderToString(HomepageSections, {
      props: { sections, content, leadSectionId: homepageLeadSection(sections, content)?.id ?? null, currencySymbol: "৳", currencyCode: "BDT", ...extra },
      locals: { storefrontTheme: Promise.resolve(requestThemeFor(DEFAULT_STOREFRONT_THEME)) },
      request: new Request("https://shop.test/"),
    });
    return parse(html);
  }

  it("marks an unavailable declared app lead without making another API read or marking later failures", async () => {
    const sections = [app("lead"), app("later")];
    const content: HomepageContent = {
      ...store("tiny"),
      apps: new Map(sections.map(({ id }) => [id, {
        sectionId: id,
        component: { pluginId: "acme.hello", type: "greeting", values: {}, media: [], lists: [] },
      }])),
    };
    // The layout has already been read; no extension is active anymore.
    let apiReads = 0;
    const page = await requestRuntime.run({
      layout: Promise.resolve(null),
      BACKEND_API: { fetch: () => { apiReads++; throw new Error("unexpected API read"); } } as unknown as Fetcher,
    }, () => renderWith(sections, content, { headerLeadSectionId: "lead" }));
    expect(apiReads).toBe(0);
    expect(page.querySelectorAll("template[data-scalius-lead-empty]")).toHaveLength(1);
    expect(page.querySelector('[data-section-id="lead"] template[data-scalius-lead-empty]')).not.toBeNull();
    expect(page.querySelector('[data-section-id="later"] template')).toBeNull();
  });

  it.each([null, " ", "<section>Hero</section>"])("guards blank or failed component output, but not successful output: %s", async (html) => {
    const sections = [app("lead")];
    const content: HomepageContent = {
      ...store("tiny"), apps: new Map([["lead", {
        sectionId: "lead",
        component: { pluginId: "acme.hello", type: "greeting", values: {}, media: [], lists: [] },
      }]]),
    };
    const draw = vi.spyOn(ExtensionHost.prototype, "render").mockResolvedValue(html);
    try {
      const page = await requestRuntime.run({ layout: Promise.resolve({ currency: { code: "BDT", symbol: "৳" }, appExtensions: [{
        pluginId: "acme.hello", version: "1.0.0", source: "bundled", release: "a".repeat(64),
        sections: ["greeting"], sectionSettings: { greeting: [] }, skins: [], blocks: [], islands: [], stylesheet: false, connect: [],
      }] } as unknown as import("@/lib/api/storefront").LayoutData) }, () => renderWith(sections, content, { headerLeadSectionId: "lead" }));
      expect(draw).toHaveBeenCalledOnce();
      expect(page.querySelector("template[data-scalius-lead-empty]") !== null).toBe(!html?.trim());
      if (html?.trim()) expect(page.querySelector("section")?.textContent).toBe("Hero");
    } finally {
      draw.mockRestore();
    }
  });

  /** Renders with the greeting app active and its module answering `html`. */
  async function renderGreeting(sections: StorefrontSection[], content: HomepageContent, extra: Record<string, unknown> = {}): Promise<Document> {
    const draw = vi.spyOn(ExtensionHost.prototype, "render").mockResolvedValue('<p class="hello">Hello <a href="/sale">sale</a></p>');
    try {
      return await requestRuntime.run({ layout: Promise.resolve(GREETING_LAYOUT) }, () => renderWith(sections, content, extra));
    } finally {
      draw.mockRestore();
    }
  }

  it("renders what the app's module drew in page order, and nothing (no box) for a section it was not given", async () => {
    const sections = [app("greeting"), section("product-rail", "rail", { source: { kind: "newest" } }), app("gone", "acme.gone/banner")];
    const content = given(store("large"), ["greeting"]);
    const page = await renderGreeting(sections, content);
    expect(Array.from(page.querySelectorAll("[data-home-section]")).map((node) => node.getAttribute("data-home-section")))
      .toEqual(["app", "product-rail"]);
    const drawn = page.querySelector('[data-home-section="app"] [data-sx-app="acme.hello"]')!;
    expect(drawn.innerHTML).toBe('<p class="hello">Hello <a href="/sale">sale</a></p>');
    expect(page.querySelector('[data-section-id="gone"]')).toBeNull();
    // An app section never leads: the rail's photos keep the page's priority.
    expect(homepageLeadSection(sections, content)?.id).toBe("rail");
    expect(homepageRenderUnits(sections, content)).toHaveLength(2);
    // Nothing given at all: no app section.
    const none = await render([app("greeting")], store("large"));
    expect(none.querySelector("[data-home-section]")).toBeNull();
  });

  it("marks app sections and their region for the theme editor and renders one alone for the render route", async () => {
    const sections = [section("faq", "faq", { heading: "", items: [{ question: "Q?", answer: "A." }] }), app("greeting")];
    const content = given(store("large"), ["greeting"]);
    const marked = await renderGreeting(sections, content, { previewMarks: true, region: "after" });
    expect(marked.querySelector('[data-theme-section-id="greeting"][data-home-section="app"]')).not.toBeNull();
    // The list's root names its region; the old layout statement is gone.
    expect(marked.querySelector('[data-theme-region="after"]')).not.toBeNull();
    expect(marked.querySelector("[data-theme-preview-layout]")).toBeNull();
    const units = Array.from(marked.querySelectorAll('[data-theme-region] > [data-home-render-unit]'));
    expect(units.map((unit) => unit.getAttribute("data-theme-section-id"))).toEqual(["faq", "greeting"]);
    // A buyer's page carries no region.
    expect((await renderGreeting(sections, content)).querySelector("[data-theme-region]")).toBeNull();

    const only = await renderGreeting(sections, content, { only: "greeting" });
    expect(Array.from(only.querySelectorAll("[data-theme-section-id]")).map((node) => node.getAttribute("data-theme-section-id"))).toEqual(["greeting"]);
    expect(only.querySelector(".hello")?.textContent).toBe("Hello sale");
  });
});

describe("section skins", () => {
  const SKIN_LAYOUT = { currency: { code: "BDT", symbol: "৳" }, appExtensions: [{
    pluginId: "acme.hello", version: "1.0.0", source: "bundled", release: "b".repeat(64),
    sections: [], sectionSettings: {}, blocks: [], islands: [], stylesheet: false, connect: [],
    skins: [{ id: "faq", target: "section:faq", settings: [] }, { id: "rail", target: "section:product-rail", settings: [] }],
  }] } as unknown as import("@/lib/api/storefront").LayoutData;
  const skinned = (each: StorefrontSection, app: string) => ({ ...each, skin: { app, values: {} } }) as StorefrontSection;

  async function renderSkinned(sections: StorefrontSection[], content: HomepageContent): Promise<Document> {
    return requestRuntime.run({ layout: Promise.resolve(SKIN_LAYOUT) }, async () => parse(await container.renderToString(HomepageSections, {
      props: { sections, content, leadSectionId: null, currencySymbol: "৳", currencyCode: "BDT" },
      locals: { storefrontTheme: Promise.resolve(requestThemeFor(DEFAULT_STOREFRONT_THEME)) },
      request: new Request("https://shop.test/"),
    })));
  }

  it("draws a core section through its skin from the resolved projection, in the section's own unit", async () => {
    const rail = skinned(section("product-rail", "rail", { title: "", source: { kind: "newest" }, limit: 4 }), "acme.hello/rail");
    const draw = vi.spyOn(ExtensionHost.prototype, "render").mockResolvedValue('<ul class="acme-rail"><li>skin</li></ul>');
    try {
      const page = await renderSkinned([rail], store("large"));
      expect(draw).toHaveBeenCalledOnce();
      const job = draw.mock.calls[0]![1] as unknown as { kind: string; target: string; instanceId: string; data: { type: string; settings: { source: { title: string; url: string | null; cards: unknown[] } } } };
      expect(job).toMatchObject({ kind: "skin", target: "section:product-rail", instanceId: "rail" });
      // The product source as the core rail shows it: its title, its listing and as many cards as the rail's limit.
      expect(job.data.type).toBe("product-rail");
      expect(job.data.settings.source).toMatchObject({ title: "New arrivals", url: "/search" });
      expect(job.data.settings.source.cards).toHaveLength(4);
      const unit = page.querySelector('[data-section-id="rail"]')!;
      expect(unit.querySelector('[data-sx-app="acme.hello"] .acme-rail')).not.toBeNull();
      expect(unit.querySelector("[data-product-card], article")).toBeNull();
    } finally {
      draw.mockRestore();
    }
  });

  it("draws the core section when the skin draws nothing, fails, or its app no longer declares it", async () => {
    const faq = section("faq", "faq", { heading: "Questions", items: [{ question: "Do you ship?", answer: "Yes." }] });
    const draw = vi.spyOn(ExtensionHost.prototype, "render").mockResolvedValue(null);
    try {
      const failed = await renderSkinned([skinned(faq, "acme.hello/faq")], EMPTY);
      expect(text(failed.querySelector('[data-section-id="faq"]'))).toContain("Do you ship?");
      expect(failed.querySelector("[data-sx-app]")).toBeNull();
      draw.mockClear();
      // A skin of another type, or of an app that does not declare it, never draws.
      const undeclared = await renderSkinned([skinned(faq, "acme.hello/rail"), skinned(section("faq", "faq-2", { heading: "", items: [{ question: "Q?", answer: "A." }] }), "acme.gone/faq")], EMPTY);
      expect(draw).not.toHaveBeenCalled();
      expect(undeclared.querySelectorAll("[data-home-section=\"faq\"]")).toHaveLength(2);
    } finally {
      draw.mockRestore();
    }
  });
});

describe("the newsletter section", () => {
  async function renderIn(sections: StorefrontSection[], languageCode: string | null) {
    const html = await container.renderToString(HomepageSections, {
      props: { sections, content: EMPTY, leadSectionId: null, currencySymbol: "৳", currencyCode: "BDT", languageCode },
      locals: { storefrontTheme: Promise.resolve(requestThemeFor(DEFAULT_STOREFRONT_THEME)) },
      request: new Request("https://shop.test/"),
    });
    return parse(html);
  }

  it("is a working form without JavaScript: a labelled phone, the e-mail as set, the consent line and a hidden honeypot", async () => {
    const page = await renderIn([section("newsletter", "news", { heading: "Join the club", text: "Eid offers first.", whatsapp: true, buttonLabel: "Join" })], "en");
    const root = page.querySelector('[data-home-section="newsletter"]')!;
    expect(text(root.querySelector("h2"))).toBe("Join the club");
    expect(text(root.querySelector("h2 + p"))).toBe("Eid offers first.");
    const form = root.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/newsletter/subscribe");
    expect(form.querySelector<HTMLInputElement>('input[name="language"]')!.value).toBe("en");

    const phone = form.querySelector<HTMLInputElement>('input[name="phone"]')!;
    expect([phone.getAttribute("type"), phone.getAttribute("autocomplete"), phone.getAttribute("inputmode"), phone.hasAttribute("required")])
      .toEqual(["tel", "tel", "tel", true]);
    expect(text(form.querySelector(`label[for="${phone.id}"]`))).toBe("Phone number");
    const email = form.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect([email.getAttribute("type"), email.getAttribute("autocomplete"), email.hasAttribute("required")]).toEqual(["email", "email", false]);
    expect(text(form.querySelector(`label[for="${email.id}"]`))).toBe("Email (optional)");
    // One unchecked box per channel the form offers; none is pre-selected.
    const channels = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="channel"]'));
    expect(channels.map((box) => [box.getAttribute("type"), box.value, box.hasAttribute("checked")]))
      .toEqual([["checkbox", "sms", false], ["checkbox", "email", false], ["checkbox", "whatsapp", false]]);
    expect(channels.map((box) => text(box.closest("label")))).toEqual(["SMS", "Email", "WhatsApp"]);

    const button = form.querySelector('button[type="submit"]')!;
    expect(text(button)).toBe("Join");
    const consent = form.querySelector(`#${button.getAttribute("aria-describedby")}`)!;
    expect(text(consent)).toBe("Choose channels for news and offers. Unsubscribe anytime.");

    // The honeypot: off screen, out of the tab order and the accessibility tree.
    const trap = form.querySelector<HTMLInputElement>('input[name="company_website"]')!;
    expect(trap.getAttribute("tabindex")).toBe("-1");
    expect(trap.getAttribute("autocomplete")).toBe("off");
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
    // A live region for the enhanced outcome, empty until a post.
    const message = form.querySelector("[data-newsletter-message]")!;
    expect(message.getAttribute("aria-live")).toBe("polite");
    expect(message.hasAttribute("hidden")).toBe(true);
    expect(duplicateIds(page)).toEqual([]);
  });

  it("asks for the e-mail as the section says and names only the channels it offers", async () => {
    const required = (await renderIn([section("newsletter", "news", { email: "required" })], "en")).querySelector("form")!;
    expect(required.querySelector('input[name="email"]')!.hasAttribute("required")).toBe(true);
    expect(text(required.querySelector('label[for$="-email"]'))).toBe("Email");

    const phoneOnly = (await renderIn([section("newsletter", "news", { email: "hidden" })], "en")).querySelector("form")!;
    expect(phoneOnly.querySelector('input[name="email"]')).toBeNull();
    expect(Array.from(phoneOnly.querySelectorAll<HTMLInputElement>('input[name="channel"]')).map((box) => box.value)).toEqual(["sms"]);
    expect(text(phoneOnly)).toContain("Choose channels for news and offers. Unsubscribe anytime.");
  });

  it("speaks Bangla in a Bangla store, merchant words first", async () => {
    const page = await renderIn([section("newsletter", "news", { whatsapp: true })], "bn-BD");
    const root = page.querySelector('[data-home-section="newsletter"]')!;
    expect(text(root.querySelector("h2"))).toBe("নতুন খবর ও অফার পান");
    expect(root.querySelector<HTMLInputElement>('input[name="language"]')!.getAttribute("value")).toBe("bn");
    expect(text(root.querySelector('label[for$="-phone"]'))).toBe("মোবাইল নম্বর");
    expect(text(root.querySelector('label[for$="-email"]'))).toBe("ইমেইল (ঐচ্ছিক)");
    expect(text(root.querySelector('button[type="submit"]'))).toBe("সাবস্ক্রাইব করুন");
    expect(text(root)).toContain("খবর ও অফার পেতে মাধ্যম বেছে নিন। যেকোনো সময় আনসাবস্ক্রাইব করতে পারবেন।");
    expect(Array.from(root.querySelectorAll<HTMLInputElement>('input[name="channel"]')).map((box) => text(box.closest("label"))))
      .toEqual(["এসএমএস", "ইমেইল", "হোয়াটসঅ্যাপ"]);
    // The script's outcome words are the page's language too.
    const copy = JSON.parse(root.querySelector("form")!.getAttribute("data-newsletter-copy")!) as { status: Record<string, { title: string }> };
    expect(copy.status.pending!.title).toBe("আপনার ইমেইল দেখুন");

    const own = await renderIn([section("newsletter", "news", { heading: "ক্লাবে যোগ দিন" })], "bn");
    expect(text(own.querySelector('[data-home-section="newsletter"] h2'))).toBe("ক্লাবে যোগ দিন");
  });

  it("keeps two signups on one page apart", async () => {
    const page = await renderIn([section("newsletter", "news"), section("newsletter", "news-2")], "en");
    expect(page.querySelectorAll("form[data-newsletter-form]")).toHaveLength(2);
    expect(duplicateIds(page)).toEqual([]);
  });
});
