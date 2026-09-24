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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_DENSITIES,
  STOREFRONT_SECTION_RENDERERS,
  STOREFRONT_SECTION_TYPES,
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
import { SHELF_CARD_SIZES } from "@/lib/product-card-layout";

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

const slide = (id: string, heading = "") => ({
  id,
  url: image(id),
  title: `Banner ${id}`,
  heading,
  buttonLabel: heading ? "Shop now" : "",
  link: heading ? "/collections/eid" : "",
  focalPoint: { x: 50, y: 50 },
});

const media = (id: string) => ({ id, url: image(id), alt: `Photo ${id}`, width: 1600, height: 1000 });

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
  return {
    hero: {
      desktop: size === "tiny" ? [slide("d1")] : [slide("d1", BANGLA), slide("d2"), slide("d3")],
      mobile: size === "tiny" ? [slide("m1")] : [slide("m1", "Eid collection"), slide("m2")],
    },
    collections: [
      { id: "col-grid", name: "Best sellers", presentation: "grid", config: { maxProducts: 8, title: "", subtitle: "" }, categories: [], products: products.slice(0, 8), featuredProduct: null },
      { id: "col-rail", name: "New in", presentation: "carousel", config: { maxProducts: 12, title: "", subtitle: "" }, categories: [], products: products.slice(0, 12), featuredProduct: null },
    ] as unknown as HomepageContent["collections"],
    categoryRail: { enabled: true, title: "Shop by category", categories },
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
    media: new Map(["m-banner", "m-banner-2", "m-look", "m-story", "m-side-1", "m-side-2"].map((id) => [id, media(id)])),
  };
}

const EMPTY: HomepageContent = {
  hero: { desktop: [], mobile: [] },
  collections: [],
  categoryRail: { enabled: false, title: "", categories: [] },
  deliveryFacts: [],
  lists: new Map(),
  media: new Map(),
};

const section = <Type extends StorefrontSectionType>(type: Type, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

/** Every renderable section type with settings that read the fixtures' data. */
const EVERY_SECTION: StorefrontSection[] = [
  section("hero", "hero", { layout: "contained-banners", sideBanners: [{ mediaId: "m-side-1", alt: "Side one", href: "/sale" }, { mediaId: "m-side-2", alt: "", href: null }] }),
  section("usp-strip", "usp"),
  section("category-tiles", "tiles", { style: "round" }),
  section("collections", "collections"),
  section("product-rail", "rail", { title: "", source: { kind: "newest" }, limit: 12 }),
  section("product-grid", "grid", { title: BANGLA, source: { kind: "category", categoryId: "cat-sarees" }, columns: 4, rows: 2 }),
  section("deal-block", "deal", { title: "Flash sale", source: { kind: "on-sale" }, endsAt: new Date(Date.now() + 86_400_000 * 2).toISOString() }),
  section("lookbook", "look", { title: "Eid looks", mediaId: "m-look", source: { kind: "collection", collectionId: "col-eid" } }),
  section("banner", "banner-1", { layout: "two-up", heading: "Eid sale", text: BANGLA, mediaId: "m-banner", cta: { label: "Shop", href: "/sale" } }),
  section("banner", "banner-2", { layout: "two-up", heading: "", text: "", mediaId: "m-banner-2", cta: null }),
  { id: "story", type: "editorial", version: 1, settings: { layout: "image-with-text", heading: "Our story", body: BANGLA, mediaId: "m-story", imageSide: "end" } },
  section("faq", "faq", { heading: "", items: [{ question: "Do you deliver outside Dhaka?", answer: BANGLA }] }),
  section("utility-cards", "utility", { cards: [{ title: "Track order", text: "Where is my parcel", href: "/track-order" }, { title: "Stores", text: "", href: "/pages/stores" }] }),
  section("endless-grid", "endless", { title: "", pageSize: 24 }),
  section("seo-text", "seo", { heading: "About us", body: "## Sarees in Bangladesh\nHandwoven.\n\nMore text." }),
];

// ─── Tests ────────────────────────────────────────────────────────────────

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
    // photo-only one is gone), the story, the FAQ, the cards and the copy.
    expect(Array.from(page.querySelectorAll("[data-home-section]")).map((node) => node.getAttribute("data-section-id")))
      .toEqual(["banner-1", "story", "faq", "utility", "seo"]);
    // No placeholders: no product grid, no rail, no hero, no empty list.
    expect(page.querySelector(".product-grid, [data-product-rail], [data-hero-layout], .desktop-carousel")).toBeNull();
    // Words alone never lead: there is no photo to load early.
    expect(homepageLeadSection(EVERY_SECTION, EMPTY)).toBeNull();
  });

  it.each(["full-bleed", "contained-banners", "app-panel", "split", "story-cards", "full-screen"] as const)(
    "renders the %s hero with the first banner as the only high-priority image",
    async (layout) => {
      const page = await render([section("hero", "hero", { layout })], store("large"));
      const high = Array.from(page.querySelectorAll('img[fetchpriority="high"]'));
      expect(high.length).toBeGreaterThan(0);
      expect(high.length).toBeLessThanOrEqual(2); // one per viewport
      if (layout === "story-cards") {
        const cards = page.querySelectorAll('[data-hero-layout="story-cards"] li');
        expect(cards).toHaveLength(3);
        expect(page.querySelector(".story-rail")!.className).toContain("snap-x");
        // The headline is real text over a scrim, never the alt text.
        expect(text(cards[0])).toContain(BANGLA);
      } else if (layout === "split") {
        expect(page.querySelectorAll('[data-hero-layout="split"] .hero-picture')).toHaveLength(3);
      } else {
        expect(page.querySelector(".desktop-carousel")).not.toBeNull();
        const rounded = page.querySelector(".desktop-carousel")!.classList.contains("rounded-xl");
        expect(rounded).toBe(layout === "contained-banners" || layout === "app-panel");
      }
      if (layout === "app-panel") expect(text(page.querySelector("[data-hero-panel]"))).toContain("Cash on delivery");
    },
  );

  it("shows side banners only beside a contained hero, and only with their images", async () => {
    const content = store("large");
    const sides = [{ mediaId: "m-side-1", alt: "Side one", href: "/sale" }, { mediaId: "missing", alt: "", href: null }];
    const page = await render([section("hero", "hero", { layout: "contained-banners", sideBanners: sides })], content);
    const banners = page.querySelectorAll("[data-hero-side-banners] img");
    expect(banners).toHaveLength(1);
    expect(banners[0]!.getAttribute("loading")).toBe("lazy");
    expect(page.querySelector('[data-hero-side-banners] a[href="/sale"]')).not.toBeNull();
    const fullBleed = await render([section("hero", "hero", { layout: "full-bleed", sideBanners: sides })], content);
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
    expect(track.querySelector("img[sizes]")!.getAttribute("sizes")).toBe(SHELF_CARD_SIZES);
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

  it("fills a product grid with columns x rows and caps its columns", async () => {
    const page = await render([section("product-grid", "grid", { title: "", source: { kind: "category", categoryId: "cat-sarees" }, columns: 5, rows: 2 })], store("large"));
    expect(page.querySelectorAll(".product-grid > *")).toHaveLength(10);
    expect(page.querySelector(".home-grid-capped")!.getAttribute("style")).toContain("--home-grid-columns: 5");
    expect(text(page.querySelector("h2"))).toBe("Sarees");
    expect(page.querySelector('a[href="/categories/sarees"]')).not.toBeNull();
  });

  it("counts a deal down only to a real end still ahead", async () => {
    const ahead = await render([section("deal-block", "deal", { title: "", source: { kind: "on-sale" }, endsAt: new Date(Date.now() + 3_600_000).toISOString() })], store("large"));
    const countdown = ahead.querySelector("[data-deal-countdown]")!;
    expect(countdown.classList.contains("invisible")).toBe(true); // shown by the script, its box laid out already
    expect(text(countdown.querySelector("time"))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(ahead.querySelector('a[href="/search?hasDiscount=true"]')).not.toBeNull();
    const ended = await render([section("deal-block", "deal", { title: "", source: { kind: "on-sale" }, endsAt: "2020-01-01T00:00:00Z" })], store("large"));
    expect(ended.querySelector("[data-deal-countdown]")).toBeNull();
    expect(ended.querySelector("[data-deal-block]")).not.toBeNull();
    const noEnd = await render([section("deal-block", "deal", { title: "", source: { kind: "on-sale" }, endsAt: null })], store("large"));
    expect(noEnd.querySelector("[data-deal-countdown]")).toBeNull();
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
    const scrim = rows[0]!.querySelector("h2")!.parentElement!;
    expect(scrim.className).toContain("from-black/80");
    expect(scrim.className).toContain("text-white");
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

  it("renders the ticker with a script-free pause and a hidden duplicate for the loop", async () => {
    const page = await render([section("usp-strip", "notice", { style: "ticker", source: { kind: "custom", items: [{ title: "New branch in Sylhet", detail: "" }] } })], store("tiny"));
    const tracks = page.querySelectorAll(".usp-ticker-track");
    expect(tracks).toHaveLength(2);
    expect(tracks[1]!.getAttribute("aria-hidden")).toBe("true");
    expect(page.querySelector('input[type="checkbox"][aria-label="Pause notices"]')).not.toBeNull();
  });

  it("keeps the photo category tiles for one category and the denser styles for two or more", async () => {
    const one: HomepageContent = { ...store("tiny"), categoryRail: { ...store("tiny").categoryRail, categories: store("tiny").categoryRail.categories.slice(0, 1) } };
    for (const style of ["icons", "round", "quad"]) {
      expect(homepageSectionRenders(section("category-tiles", "tiles", { style }), one)).toBe(false);
    }
    expect(homepageSectionRenders(section("category-tiles", "tiles", { style: "photo" }), one)).toBe(true);
    const quad = await render([section("category-tiles", "tiles", { style: "quad" })], store("large"));
    // Twelve categories make three cards of four.
    expect(quad.querySelectorAll("ul > li > ul")).toHaveLength(3);
    // A category without a photo shows its first letter in the same box.
    expect(text(quad.querySelector('a[href="/categories/category-0"] span'))).toBe("C");
  });

  it("maps each registry type to its own renderer", () => {
    for (const type of STOREFRONT_SECTION_RENDERERS) {
      expect(storefrontSectionRenderer(storefrontSectionDefault(type, "x"))).toBe(type);
    }
  });
});
