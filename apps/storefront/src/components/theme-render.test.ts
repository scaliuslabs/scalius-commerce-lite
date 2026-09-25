// @vitest-environment node
/**
 * Render-only theme coverage (no browser): renders the real storefront Astro
 * components with Astro's container API, through a Vite dev server in
 * middleware mode, for every template with every block variant (deduplicated by
 * the renderer each maps to today), and checks the markup invariants each
 * choice promises. Layout, overlap, contrast and
 * LCP timing need a browser; this catches wrong markup cheaply in CI.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_DENSITIES,
  STOREFRONT_TEMPLATE_IDS,
  buildStorefrontThemeTokens,
  storeShapeFromFacts,
  storefrontBlockDefault,
  storefrontBlockVariants,
  storefrontSectionRenderer,
  storefrontTemplateTheme,
  storefrontThemeDocumentSchema,
  type StoreShape,
  type StorefrontBlockSlot,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { requestThemeFor } from "@/lib/storefront-theme-context";
import {
  productCardImageSizes,
  productGridFirstRow,
  productGridFluidCss,
  productGridSpec,
} from "@/lib/product-card-layout";
import { CARD_IMAGE_DIMENSIONS } from "@/components/cards/card-model";
import { homepageLeadSection, homepageSectionRenders, type HomepageContent } from "@/lib/homepage-sections";
import { heroImageCandidate } from "@/lib/homepage-hero";
import {
  productGalleryMainSlot,
  productGalleryThumbnailSlot,
} from "@/components/product/lib/gallery-images";
import { HEADER_SPECS, headerCondense, headerSpec } from "@/components/header/header-variants";
import { fitNavOverflow } from "@/components/header/nav-disclosure";
import { HEADER_LINK_BUDGET } from "@/components/header/nav-tree";

// ─── Harness ──────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL("../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  // Normally provided by the @astrojs/react and partytown integrations.
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

type AstroComponent = unknown;
interface Container {
  renderToString(
    component: AstroComponent,
    options: { props?: object; slots?: Record<string, string>; locals?: object; request?: Request },
  ): Promise<string>;
}

let server: ViteDevServer;
let container: Container;
const components = new Map<string, AstroComponent>();

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
          name: "storefront-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0render-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0render-test:") ? VIRTUAL_MODULES[id.slice("\0render-test:".length)] : undefined,
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
}, 120_000);

afterAll(async () => {
  await server?.close();
});

async function component(path: string): Promise<AstroComponent> {
  if (!components.has(path)) components.set(path, (await server.ssrLoadModule(path)).default);
  return components.get(path);
}

async function render(
  path: string,
  theme: StorefrontThemeDocument,
  props: object,
  slots?: Record<string, string>,
  url = "https://shop.test/",
  shape: StoreShape = STORE_SHAPE,
): Promise<string> {
  const requestTheme = requestThemeFor(theme, shape);
  return container.renderToString(await component(path), {
    props,
    slots,
    // The shape lib/storefront-theme-context keeps per request.
    locals: { storefrontTheme: Promise.resolve(requestTheme) },
    request: new Request(url),
  });
}

// A fresh DOM per test: the parsed pages of hundreds of renders would
// otherwise stay reachable from one window and exhaust the worker's heap.
let window = new Window();
afterEach(async () => {
  const previous = window;
  window = new Window();
  await previous.happyDOM.close();
});
function parse(html: string): Document {
  return new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
}

function duplicateIds(document: Document): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const element of Array.from(document.querySelectorAll("[id]"))) {
    if (seen.has(element.id)) duplicates.add(element.id);
    seen.add(element.id);
  }
  return [...duplicates];
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const image = (name: string) => `https://cdn.shop.test/products/${name}.jpg`;

/**
 * A store every block variant fits (a small catalogue with a two-level
 * menu), so each variant renders as itself; fallbacks are tested in
 * packages/shared.
 */
const STORE_SHAPE = storeShapeFromFacts({
  productCount: 120,
  skuCount: 300,
  topCategoryCount: 8,
  categoryDepth: 1,
  menu: Array.from({ length: 6 }, () => ({ subMenu: [{ subMenu: [{}, {}] }, { subMenu: [{}, {}] }] })),
  hasCollections: true,
  hasDeliveryMethods: true,
});
const resolveLayout = (theme: StorefrontThemeDocument) => requestThemeFor(theme, STORE_SHAPE).layout;

function product(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    description: null,
    price: 1200,
    discountedPrice: 1200,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    freeDelivery: false,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    categoryId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    imageUrl: image(id),
    imageAlt: null,
    hasVariants: false,
    availableForSale: true,
    ...overrides,
  };
}

/** One card per card-relevant state. */
const CARD_PRODUCTS = {
  simpleOnSale: product("sale", {
    discountedPrice: 960,
    discountType: "percentage",
    discountPercentage: 20,
    secondaryImageUrl: image("sale-back"),
  }),
  withOptions: product("options", { hasVariants: true, priceVaries: true, secondaryImageUrl: image("options-back") }),
  soldOut: product("soldout", { availableForSale: false }),
  plain: product("plain"),
};

const slide = (id: string) => ({
  id,
  url: `https://cdn.shop.test/banners/${id}.jpg`,
  title: `Banner ${id}`,
  heading: "",
  buttonLabel: "",
  link: "",
  focalPoint: { x: 50, y: 50 },
});

const HOMEPAGE_DATA = {
  hero: {
    // m1 has renditions (its URL is the 1080px master), the others don't.
    desktop: [slide("d1"), slide("d2")],
    mobile: [{ ...slide("m1"), url: "https://cdn.shop.test/media/m1.jpg/1080.webp" }],
  },
  collections: [
    {
      id: "col-grid",
      name: "Best sellers",
      presentation: "grid",
      config: {},
      products: [CARD_PRODUCTS.simpleOnSale, CARD_PRODUCTS.plain],
    },
    {
      id: "col-rail",
      name: "New in",
      presentation: "carousel",
      config: {},
      products: [CARD_PRODUCTS.withOptions, CARD_PRODUCTS.soldOut],
    },
  ],
  categoryRail: {
    enabled: true,
    title: "Shop by category",
    categories: [
      { id: "c1", name: "Sarees", slug: "sarees", description: null, imageUrl: image("sarees"), canonicalPath: null },
      { id: "c2", name: "Panjabi", slug: "panjabi", description: null, imageUrl: null, canonicalPath: null },
    ],
  },
  deliveryFacts: [
    { kind: "delivery", title: "Delivery in 2-3 days", detail: "Across Bangladesh" },
    { kind: "cod", title: "Cash on delivery", detail: "Pay when it arrives" },
  ],
};
/** Every product list a template's sections read has the same four cards. */
const SECTION_LISTS = ["newest", "on-sale", "popular"].map((key) => ({
  key,
  products: Object.values(CARD_PRODUCTS),
  category: null,
  collection: null,
}));
const HOMEPAGE_CONTENT: HomepageContent = {
  hero: HOMEPAGE_DATA.hero,
  collections: HOMEPAGE_DATA.collections as unknown as HomepageContent["collections"],
  categoryRail: HOMEPAGE_DATA.categoryRail,
  deliveryFacts: HOMEPAGE_DATA.deliveryFacts as HomepageContent["deliveryFacts"],
  lists: new Map(SECTION_LISTS.map((list) => [list.key, list as never])),
  media: new Map(),
};
const HOMEPAGE_PROPS = { content: HOMEPAGE_CONTENT, currencySymbol: "৳", currencyCode: "BDT" };
const NO_HERO = { desktop: [], mobile: [] };

const LONG_MENU = [
  "Women", "Men", "Kids", "Home & living", "Beauty", "Jewellery", "Gifts",
  "Handicrafts", "Festive collection", "Sale", "New arrivals", "Brands",
].map((title, index) => ({
  id: `nav-${index}`,
  title,
  href: `/categories/${title.toLowerCase().replace(/[^a-z]+/g, "-")}`,
  subMenu: index === 0 ? [{ id: "nav-0-0", title: "Sarees", href: "/categories/sarees" }] : undefined,
}));

const FOOTER_MENUS = ["Shop", "Help", "Company", "Stories"].map((title, menuIndex) => ({
  id: `menu-${menuIndex}`,
  title,
  links: Array.from({ length: 5 }, (_, linkIndex) => ({
    id: `menu-${menuIndex}-${linkIndex}`,
    title: `${title} link ${linkIndex + 1}`,
    href: `/${title.toLowerCase()}-${linkIndex + 1}`,
  })),
}));

const BUSINESS = {
  companyName: "Nakshi Ghor",
  phone: "+8801712345678",
  email: "hello@nakshighor.test",
  addressLine1: "House 12, Road 5",
  city: "Dhaka",
  country: "Bangladesh",
};

function layoutData(options: { business: boolean }) {
  return {
    analytics: [],
    header: {
      topBar: { text: "Free delivery in Dhaka over ৳2000", isEnabled: true },
      logo: { src: "", alt: "Nakshi Ghor" },
      favicon: { src: "", alt: "" },
      contact: { phone: "", text: "", isEnabled: true },
      social: [],
    },
    navigation: LONG_MENU,
    footer: {
      logo: { src: "", alt: "Nakshi Ghor" },
      tagline: "Handmade in Bangladesh",
      description: "",
      copyrightText: "Nakshi Ghor",
      menus: FOOTER_MENUS,
      social: [{ label: "Facebook", platform: "facebook", url: "https://facebook.com/nakshighor" }],
    },
    currency: { code: "BDT", symbol: "৳", usdExchangeRate: 120, decimalPlaces: 0 },
    business: options.business ? BUSINESS : undefined,
    policies: [
      { kind: "refund", title: "Refund policy", path: "/refund-policy" },
      { kind: "privacy", title: "Privacy policy", path: "/privacy-policy" },
    ],
  };
}

const GALLERY_MEDIA = ["front", "back", "detail"].map((name, index) => ({
  id: `pm-${name}`,
  mediaId: `media-${name}`,
  kind: "image",
  url: `https://cdn.shop.test/media/${name}.jpg/1600.webp`,
  posterMediaId: null,
  posterUrl: null,
  altText: `Kurta ${name}`,
  caption: null,
  width: 1200,
  height: 1200,
  durationMs: null,
  isPrimary: index === 0,
  sortOrder: index,
  status: "ready",
}));

// ─── The matrix: every template with every block variant ─────────────────

/** A document with one block (or the density token) changed. */
function withChoice(base: StorefrontThemeDocument, axis: MatrixAxis, value: string): StorefrontThemeDocument {
  const theme = structuredClone(base) as StorefrontThemeDocument;
  if (axis === "density") theme.tokens.density = value as never;
  else if (axis === "gallery") theme.blocks.product.gallery = storefrontBlockDefault("gallery", value) as never;
  else theme.blocks[axis] = storefrontBlockDefault(axis, value) as never;
  return storefrontThemeDocumentSchema.parse(theme);
}

// Navigation has its own matrix below (every menu with every phone menu and
// header), which renders only the Layout, so this one stays fast.
type MatrixAxis = Extract<StorefrontBlockSlot, "topBar" | "header" | "footer" | "card" | "gallery"> | "density";
const MATRIX_AXES: Record<MatrixAxis, readonly string[]> = {
  topBar: storefrontBlockVariants("topBar"),
  header: storefrontBlockVariants("header"),
  footer: storefrontBlockVariants("footer"),
  card: storefrontBlockVariants("card"),
  gallery: storefrontBlockVariants("gallery"),
  density: STOREFRONT_DENSITIES,
};

/** What a choice on an axis renders: the variant itself for the header blocks (each has its own renderer), renderer facts otherwise. */
function axisFacts(axis: MatrixAxis, theme: StorefrontThemeDocument): unknown {
  const { layout, resolved } = requestThemeFor(theme, STORE_SHAPE);
  if (axis === "topBar") return resolved.blocks.topBar.variant;
  if (axis === "header") return resolved.blocks.header.variant;
  if (axis === "footer") return resolved.blocks.footer.variant;
  if (axis === "card") return layout.productCard;
  if (axis === "gallery") return layout.productPage;
  return layout.density;
}

const MATRIX = (() => {
  const seen = new Set<string>();
  return STOREFRONT_TEMPLATE_IDS.flatMap((template) =>
    (Object.entries(MATRIX_AXES) as Array<[MatrixAxis, readonly string[]]>).flatMap(([axis, values]) =>
      values.map((value) => {
        const theme = withChoice(storefrontTemplateTheme(template), axis, value);
        const { blocks } = requestThemeFor(theme, STORE_SHAPE).resolved;
        const key = `${template} ${JSON.stringify(resolveLayout(theme))} ${blocks.topBar.variant} ${blocks.header.variant} ${blocks.footer.variant}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return { name: `${template}: ${axis}=${value}`, template, axis, theme };
      }),
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  );
})();

describe("storefront theme render matrix", () => {
  it("covers every pair of desktop menu, phone menu and header", () => {
    const pairs = new Set(NAVIGATION_MATRIX.flatMap(({ desktop, phone, header }) => {
      const d = `${desktop.variant}${JSON.stringify(desktop.settings)}`;
      const p = `${phone.variant}${JSON.stringify(phone.settings)}`;
      return [`d${d}|p${p}`, `d${d}|h${header}`, `p${p}|h${header}`];
    }));
    expect(pairs.size).toBe(DESKTOP_MENUS.length * PHONE_MENUS.length + DESKTOP_MENUS.length * HEADERS.length + PHONE_MENUS.length * HEADERS.length);
  });

  it("covers every template with every renderer each axis can reach", () => {
    for (const [axis, values] of Object.entries(MATRIX_AXES) as Array<[MatrixAxis, readonly string[]]>) {
      for (const template of STOREFRONT_TEMPLATE_IDS) {
        const reachable = new Set(values.map((value) => JSON.stringify(axisFacts(axis, withChoice(storefrontTemplateTheme(template), axis, value)))));
        const rendered = new Set(
          MATRIX.filter((entry) => entry.template === template).map((entry) => JSON.stringify(axisFacts(axis, entry.theme))),
        );
        for (const facts of reachable) expect(rendered.has(facts), `${template} ${axis} ${facts}`).toBe(true);
      }
    }
  });

  it.each(MATRIX)("$name", async ({ theme }) => {
    const { layout, resolved } = requestThemeFor(theme, STORE_SHAPE);
    const sections = resolved.pages.home;
    const leadSectionId = homepageLeadSection(sections, HOMEPAGE_CONTENT)?.id ?? null;

    // Homepage inside the full Layout (header, footer, mobile menu).
    const homepage = await render("/src/components/homepage/HomepageSections.astro", theme, {
      ...HOMEPAGE_PROPS,
      sections,
      leadSectionId,
    });
    const page = parse(
      await render(
        "/src/layouts/Layout.astro",
        theme,
        { title: "Home", layoutData: layoutData({ business: true }) },
        { default: homepage },
      ),
    );
    expect(duplicateIds(page)).toEqual([]);
    // Body attributes the CSS reads.
    const body = page.body;
    expect(body.dataset.themeDensity).toBe(theme.tokens.density);
    expect(body.dataset.themeCardStyle).toBe(layout.cardSurface);
    // The type pairing (editorial section headings step up on computers).
    expect(body.dataset.themeTypography).toBe(theme.tokens.typography);
    // Tokens the card and heading CSS select on.
    expect(body.dataset.themeTypeScale).toBe(theme.tokens.typeScale);
    expect(body.dataset.themeHeadingCase).toBe(theme.tokens.headingCase);
    expect(body.dataset.themeImageFit).toBe(theme.tokens.imageFit);
    expect(body.dataset.themeRadius).toBe(theme.tokens.radius);
    expect(body.hasAttribute("data-theme-button-style")).toBe(false);
    // The density's grid tokens and fluid steps reach :root.
    const themeCss = Array.from(page.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .find((text) => text.startsWith(":root, .site-root"))!;
    const fluid = productGridFluidCss(productGridSpec(layout.grid, theme.tokens.imageRatio));
    expect(themeCss).toContain(`--theme-card-min-phone: ${layout.grid.cardMin.phone}`);
    expect(themeCss).toContain(`--grid-card-min-fluid: ${fluid.cardMin}`);
    expect(themeCss).toContain(`--grid-gap-fluid: ${fluid.gap}`);
    // Every product grid sits in its container frame.
    const grids = Array.from(page.querySelectorAll(".product-grid"));
    const renderers = sections.map(storefrontSectionRenderer);
    if (renderers.includes("collections")) expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) expect(grid.parentElement!.classList.contains("product-grid-frame")).toBe(true);

    // Top bar and header: each variant's own structure.
    assertTopBar(page, resolved.blocks.topBar.variant, layout.topBar);
    assertHeader(page, resolved.blocks.header.variant, layout.header);

    // Homepage sections in document order: those with data to show.
    expect(
      Array.from(page.querySelectorAll("[data-home-section]")).map((node) => node.getAttribute("data-home-section")),
    ).toEqual(sections.filter((section) => homepageSectionRenders(section, HOMEPAGE_CONTENT)).map((section) => section.type));
    // The banner's first photo is high priority wherever it sits (one of at
    // most two photo sections, so it is at or just below the fold).
    const heroSection = sections.find((section) => section.type === "hero");
    if (heroSection?.type === "hero") {
      const hero = page.querySelector('[data-home-section="hero"]')!;
      expect(hero.querySelectorAll('img[fetchpriority="high"]').length).toBeGreaterThan(0);
      const layout = heroSection.settings.layout;
      if (layout !== "split" && layout !== "story-cards") {
        // Phones get a phone-sized rendition, and the first slide paints without script.
        const phoneSource = page.querySelector(".mobile-carousel [data-slide-index='0'] source")!;
        expect(phoneSource.getAttribute("srcset")).toContain("https://cdn.shop.test/media/m1.jpg/640.webp 640w");
        expect(phoneSource.getAttribute("sizes")).toBe(heroImageCandidate(HOMEPAGE_DATA.hero.mobile[0]!.url, "mobile", layout).sizes);
        expect(page.querySelector(".desktop-carousel [data-slide-index='0'] source")!.getAttribute("sizes")).toBeNull();
        expect(page.querySelector(".mobile-carousel [data-slide-index='0']")!.classList.contains("opacity-100")).toBe(true);
      }
    }

    // Footer: the variant's structure, with contact links from business facts.
    assertFooter(page, resolved.blocks.footer.variant, { business: true });
    const bare = parse(
      await render("/src/layouts/Layout.astro", theme, { title: "Home", layoutData: layoutData({ business: false }) }),
    );
    assertFooter(bare, resolved.blocks.footer.variant, { business: false });

    // Product cards.
    const cards = parse(
      (
        await Promise.all(
          Object.values(CARD_PRODUCTS).map((cardProduct, index) =>
            render("/src/components/cards/ProductCard.astro", theme, { product: cardProduct, index, aboveFold: true }),
          ),
        )
      ).join(""),
    );
    assertCards(cards, theme);

    // Product page layout and gallery.
    const gallery = await render("/src/components/product/ProductGallery.astro", theme, {
      product: product("kurta", { imageMediaId: "media-front" }),
      media: GALLERY_MEDIA,
      layout: layout.productPage,
    });
    const productPage = parse(
      await render(
        "/src/components/product/ProductPageLayout.astro",
        theme,
        { gallery: layout.productPage.gallery },
        { default: gallery },
      ),
    );
    expect(productPage.querySelector(".product-layout")!.getAttribute("data-gallery")).toBe(layout.productPage.gallery);
    expect(productPage.querySelector("#product-gallery")!.getAttribute("data-thumbnails")).toBe(
      layout.productPage.thumbnails,
    );
    // Both main images carry one responsive source set sized to the slot, so
    // the browser fetches a single candidate for whichever one is visible.
    const mainSizes = productGalleryMainSlot(layout.productPage, true).sizes;
    const mainImages = [
      productPage.querySelector("[data-mobile-main-image]")!,
      productPage.querySelector("[data-desktop-main-image]")!,
    ];
    for (const mainImage of mainImages) {
      expect(mainImage.getAttribute("src")).toBe("https://cdn.shop.test/media/front.jpg/960.webp");
      expect(mainImage.getAttribute("srcset")).toContain("https://cdn.shop.test/media/front.jpg/1600.webp 1600w");
      expect(mainImage.getAttribute("sizes")).toBe(mainSizes);
      expect(mainImage.getAttribute("loading")).toBe("eager");
      expect(mainImage.getAttribute("fetchpriority")).toBe("high");
      expect(mainImage.getAttribute("alt")).toBe("Kurta front");
    }
    expect(productPage.querySelector("#product-gallery")!.getAttribute("data-main-sizes")).toBe(mainSizes);
    for (const rail of ["mobile", "desktop"] as const) {
      const thumbs = productPage.querySelectorAll(`[data-thumbnail-rail="${rail}"] [data-gallery-thumbnail] img`);
      expect(thumbs).toHaveLength(GALLERY_MEDIA.length);
      for (const thumb of thumbs) {
        expect(thumb.getAttribute("loading")).toBe("lazy");
        expect(thumb.getAttribute("sizes")).toBe(productGalleryThumbnailSlot(layout.productPage, rail).sizes);
        expect(thumb.getAttribute("srcset")).toMatch(/\/160\.webp 160w, \S+\/320\.webp 320w$/);
      }
    }
    expect(duplicateIds(productPage)).toEqual([]);
  });

  it("renders the default theme's product page and homepage as the classic store", () => {
    const { layout, resolved } = requestThemeFor(DEFAULT_STOREFRONT_THEME, STORE_SHAPE);
    expect(layout).toMatchObject({
      header: "classic",
      navigation: "menu",
      mobileNavigation: "drawer",
      footer: "columns",
      productPage: { gallery: "beside", thumbnails: "beside" },
      productCard: { imageRatio: "square", hoverImage: false, quickBuy: false, badge: "image" },
      density: "compact",
      cardSurface: "bordered",
      topBar: true,
    });
    expect(resolved.pages.home.map(storefrontSectionRenderer)).toEqual(["hero", "collections", "category-tiles", "usp-strip"]);
    // Today's announcement bar, classic header, dropdown row, drawer and columns footer.
    expect(resolved.blocks.topBar.variant).toBe("announcement");
    expect(resolved.blocks.header.variant).toBe("mall-departments");
    expect(resolved.blocks.desktopNav.variant).toBe("dropdown");
    expect(resolved.blocks.mobileNav.variant).toBe("accordion-drawer");
    expect(["product-widgets", "minimal-columns"]).toContain(resolved.blocks.footer.variant);
  });

  it("renders the default header as the classic header, markup for markup", async () => {
    const page = parse(
      await render(
        "/src/layouts/Layout.astro",
        DEFAULT_STOREFRONT_THEME,
        { title: "Home", layoutData: { ...layoutData({ business: true }), navigation: LONG_MENU } },
      ),
    );
    const header = page.querySelector("#main-header")!;
    expect(header.getAttribute("data-header-style")).toBe("classic");
    // The version 3 bar: the centred search button, the account and cart pill with its total.
    expect(header.querySelector(".header-row #desktop-search-trigger")).not.toBeNull();
    expect(header.querySelector("[data-header-action-group] #account-link")).not.toBeNull();
    expect(header.querySelector("[data-header-action-group] #cart-button #cart-total-display")).not.toBeNull();
    expect(header.querySelector(".header-full-nav-row #desktop-nav[data-nav-style='menu']")).not.toBeNull();
    // On scroll the row's menu itself moves into the bar (one set of links in the HTML).
    expect(header.hasAttribute("data-header-condense")).toBe(true);
    expect(header.querySelector("[data-nav-compact-from='desktop-nav']")!.children).toHaveLength(0);
    // The announcement bar precedes the header, as before.
    const bar = page.querySelector("#site-header > .bg-primary")!;
    expect(bar.textContent).toContain("Free delivery in Dhaka over");
    expect(bar.nextElementSibling).toBe(header);
  });
});

function assertTopBar(page: Document, variant: string, shows: boolean) {
  expect(page.body.textContent?.includes("Free delivery in Dhaka over")).toBe(shows);
  const utility = page.querySelector('[data-top-bar="utility"]');
  const appBanner = page.querySelector('[data-top-bar="app-banner"]');
  expect(Boolean(utility)).toBe(variant === "utility");
  expect(Boolean(appBanner)).toBe(variant === "app-banner");
  if (utility) {
    // Track order and account at the end (the store phone lives in business settings).
    expect(utility.querySelector('a[href="/track-order"]')).not.toBeNull();
    expect(utility.querySelector('a[href="/account"][data-account-link]')).not.toBeNull();
  }
  if (appBanner) {
    // Dismissible before hydration: an open <details> whose summary closes it.
    expect(appBanner.tagName).toBe("DETAILS");
    expect(appBanner.hasAttribute("open")).toBe(true);
    expect(appBanner.querySelector("summary")!.getAttribute("aria-label")).toBe("Dismiss");
  }
}

function assertHeader(page: Document, variant: string, renderer: string) {
  const header = page.querySelector("#main-header")!;
  expect(header.getAttribute("data-header-style")).toBe(renderer);
  expect(header.getAttribute("data-header-variant")).toBe(variant);
  // One of each control, whatever the variant (the header script binds them by id).
  for (const id of ["mobile-menu-toggle", "cart-button", "account-link", "cart-count"]) {
    expect(page.querySelectorAll(`#${id}`), id).toHaveLength(1);
  }
  // The phone menu opens without JavaScript too (the drawer's :target).
  expect(page.querySelector('#site-header noscript')?.innerHTML ?? "").toContain('href="#mobile-menu-panel"');
  expect(page.querySelector("#mobile-menu-panel")!.hasAttribute("inert")).toBe(false);
  if (variant === "mall-departments") {
    expect(header.querySelector(".header-row")).not.toBeNull();
    expect(page.querySelector("#mobile-search-toggle")).not.toBeNull();
    return;
  }
  const spec = HEADER_SPECS[variant as keyof typeof HEADER_SPECS];
  expect(header.querySelector(".hdr-main")!.getAttribute("data-tone")).toBe(spec.toneRow ? "tone" : "surface");
  expect(header.getAttribute("data-hdr-utilities")).toBe(spec.utilities);
  // Search: a real GET form to /search (it works before hydration), or the icon.
  const forms = Array.from(page.querySelectorAll("form[data-header-search]"));
  if (spec.search === "icon") {
    expect(header.querySelector('a[href="/search"][data-search-open]')).not.toBeNull();
  } else {
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.getAttribute("action")).toBe("/search");
      expect(form.getAttribute("method")).toBe("get");
      expect(form.querySelector("input[name='q']")).not.toBeNull();
      expect(form.querySelector("label")!.getAttribute("for")).toBe(form.querySelector("input")!.id);
    }
  }
  const scope = page.querySelector("select[data-search-scope]");
  expect(Boolean(scope)).toBe(spec.search === "scoped");
  if (scope) {
    // Department scopes from the menu's category links; no name, so it never reaches the query.
    expect(scope.hasAttribute("name")).toBe(false);
    expect(Array.from(scope.querySelectorAll("option")).map((option) => option.getAttribute("value"))).toContain("/categories/women");
  }
  // Phones: a search row (sticky, or in the page under the bar) or the search icon.
  expect(Boolean(header.querySelector(".hdr-phone-search"))).toBe(spec.phoneSearch === "sticky");
  expect(Boolean(page.querySelector(".hdr-phone-search--page"))).toBe(spec.phoneSearch === "in-page");
  expect(Boolean(page.querySelector("#mobile-search-toggle"))).toBe(spec.phoneSearch === "none");
  // The running cart total only where the variant shows it.
  expect(Boolean(header.querySelector("#cart-total-display"))).toBe(spec.cartTotal);
}

function assertFooter(page: Document, variant: string, options: { business: boolean }) {
  const footer = page.querySelector("footer")!;
  expect(footer.getAttribute("data-footer-variant")).toBe(variant);
  const tel = footer.querySelectorAll('a[href^="tel:"]');
  const whatsapp = footer.querySelectorAll('a[href^="https://wa.me/"]');
  const headings = Array.from(footer.querySelectorAll("h2")).map((node) => node.textContent?.trim());
  const policies = ["/refund-policy", "/privacy-policy"];
  const hrefs = Array.from(footer.querySelectorAll("a")).map((link) => link.getAttribute("href"));
  // Every footer links every menu link and the policy pages (payment gateways require them).
  expect(hrefs).toEqual(expect.arrayContaining([...FOOTER_MENUS.flatMap((menu) => menu.links.map((link) => link.href)), ...policies]));
  // "Track your order" once (placed in the Help menu).
  expect(hrefs.filter((href) => href === "/track-order")).toHaveLength(1);
  // No v3 "Need help ordering?" block survives in any variant.
  expect(headings).not.toContain("Need help ordering?");
  const tone = footer.getAttribute("data-footer-tone");
  const toneByVariant: Record<string, string | null> = {
    "support-dark": "header",
    "brand-black": "ink",
    "newsletter-grey": "muted",
  };
  expect(tone).toBe(toneByVariant[variant] ?? null);

  if (variant === "newsletter-grey") {
    // One centred band of every link; the policies are in it, not below.
    const band = footer.querySelector('nav[aria-label="Footer"]')!;
    const links = Array.from(band.querySelectorAll("a"));
    expect(links).toHaveLength(FOOTER_MENUS.length * 5 + 3);
    expect(footer.querySelector('nav[aria-label="Store policies"]')).toBeNull();
  } else if (variant === "directory") {
    const directory = footer.querySelector('nav[aria-label="Store directory"]')!;
    expect(directory.querySelectorAll("a").length).toBeLessThanOrEqual(60);
    expect(headings).toEqual(expect.arrayContaining(["Customer care", ...FOOTER_MENUS.map((menu) => menu.title)]));
  } else {
    expect(headings).toEqual(expect.arrayContaining(FOOTER_MENUS.map((menu) => menu.title)));
  }
  if (variant === "brand-black") expect(headings).toContain("Policies");

  if (!options.business) {
    expect(tel).toHaveLength(0);
    expect(whatsapp).toHaveLength(0);
    expect(footer.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(footer.querySelector("address")).toBeNull();
    // Contact blocks are left out, never shown empty.
    expect(footer.querySelector("[data-footer-contact]")).toBeNull();
    expect(headings).not.toContain("Support");
    expect(headings).not.toContain("Visit us");
    return;
  }
  expect(tel.length).toBeGreaterThan(0);
  const columns = variant === "minimal-columns" || variant === "product-widgets";
  expect(whatsapp.length).toBe(["support-dark", "newsletter-grey", "directory"].includes(variant) ? 1 : 0);
  expect(Boolean(footer.querySelector('a[href^="mailto:"]'))).toBe(!columns && variant !== "newsletter-grey");
  expect(Boolean(footer.querySelector("address"))).toBe(variant === "support-dark" || variant === "brand-black");
}

function assertCards(document: Document, theme: StorefrontThemeDocument) {
  const { layout, resolved } = requestThemeFor(theme, STORE_SHAPE);
  const containerWidth = buildStorefrontThemeTokens(theme)["theme-container-width"]!;
  const grid = productGridSpec(layout.grid, theme.tokens.imageRatio);
  const firstRow = productGridFirstRow(grid, containerWidth);
  const card = layout.productCard;
  const cards = Array.from(document.querySelectorAll('[data-theme-component="product-card"]'));
  expect(cards).toHaveLength(Object.keys(CARD_PRODUCTS).length);
  const [onSale, withOptions, soldOut, plain] = cards as [Element, Element, Element, Element];

  cards.forEach((element, index) => {
    // The resolved card variant, in the theme's photo ratio (a token).
    expect(element.getAttribute("data-card-variant")).toBe(resolved.blocks.card.variant);
    expect(element.getAttribute("data-card-ratio")).toBe(theme.tokens.imageRatio);
    const media = element.querySelector(".product-card-media")!;
    const photo = media.querySelector("img")!;
    // `sizes` follows the density's fluid grid within the container cap.
    expect(photo.getAttribute("sizes")).toBe(productCardImageSizes(grid, containerWidth));
    expect(photo.getAttribute("sizes")).toMatch(/^\(max-width: \d+px\) calc\(100vw - \d+px\), \(max-width: \d+px\) calc\(50vw - \d+px\), /);
    expect(photo.getAttribute("height")).toBe(String(CARD_IMAGE_DIMENSIONS[theme.tokens.imageRatio].height));
    // First row eager, a phone row (the first two photos) high priority.
    expect(photo.getAttribute("loading")).toBe(index < firstRow ? "eager" : "lazy");
    expect(photo.getAttribute("fetchpriority")).toBe(index < 2 && index < firstRow ? "high" : "auto");
    // One link per card (the stretched title link) plus at most Buy now.
    const links = element.querySelectorAll("a");
    expect(links.length).toBeLessThanOrEqual(2);
  });

  // Hover photo only where the card shows one (and only with a second photo).
  expect(Boolean(onSale.querySelector(".product-card-hover-image"))).toBe(card.hoverImage);
  expect(Boolean(withOptions.querySelector(".product-card-hover-image"))).toBe(card.hoverImage);
  expect(plain.querySelector(".product-card-hover-image")).toBeNull();

  // A buy action only on cards with one, only in stock without options; it
  // sits above the stretched card link. The card matrix
  // (cards/product-card.render.test.ts) covers each anatomy in detail.
  const buyNow = (element: Element) => element.querySelector('a[href^="/buy/"]');
  expect(Boolean(buyNow(onSale))).toBe(card.quickBuy);
  expect(Boolean(buyNow(plain))).toBe(card.quickBuy);
  expect(buyNow(withOptions)).toBeNull();
  expect(buyNow(soldOut)).toBeNull();
  if (card.quickBuy) expect(buyNow(onSale)!.className).toMatch(/\b(?:relative|absolute)\b.*\bz-10\b/);

  // The discount badge sits on the photo or next to the price.
  expect(Boolean(onSale.querySelector(".product-card-media [data-card-discount]"))).toBe(card.badge === "image");
  expect(Boolean(onSale.querySelector(".product-card-price-row [data-card-discount]"))).toBe(card.badge === "price");
  expect(soldOut.textContent).toContain("Sold out");
}

// ─── Navigation: every desktop menu with every phone menu and header ─────

/** Three levels, photos on some categories, a parent without a link. */
const NAVIGATION = [
  {
    id: "women",
    title: "Women",
    href: "/categories/women",
    imageUrl: image("women"),
    subMenu: [
      {
        id: "sarees",
        title: "Sarees",
        href: "/categories/sarees",
        imageUrl: image("sarees"),
        subMenu: [
          { id: "silk", title: "Silk sarees", href: "/categories/silk-sarees", imageUrl: image("silk") },
          { id: "cotton", title: "Cotton sarees", href: "/categories/cotton-sarees" },
        ],
      },
      { id: "kurtis", title: "Kurtis", href: "/categories/kurtis" },
    ],
  },
  { id: "men", title: "Men", subMenu: [{ id: "panjabi", title: "Panjabi", href: "/categories/panjabi", imageUrl: image("panjabi") }] },
  { id: "sale", title: "Sale", href: "/sale" },
];
const CURRENT_PAGE = "https://shop.test/categories/silk-sarees";

/** Star Tech scale: 18 departments x 12 children x 6 brands (1,530 links). */
const HUGE_NAVIGATION = Array.from({ length: 18 }, (_, top) => ({
  id: `d${top}`,
  title: `Department ${top}`,
  href: `/categories/d${top}`,
  subMenu: Array.from({ length: 12 }, (_, child) => ({
    id: `d${top}-${child}`,
    title: `Child ${top}.${child}`,
    href: `/categories/d${top}-${child}`,
    subMenu: Array.from({ length: 6 }, (_, leaf) => ({
      id: `d${top}-${child}-${leaf}`,
      title: `Brand ${leaf}`,
      href: `/categories/d${top}-${child}-${leaf}`,
    })),
  })),
}));

type Choice = { variant: string; settings: Record<string, unknown> };
const choice = (slot: StorefrontBlockSlot, variant: string, settings: Record<string, unknown> = {}): Choice => ({
  variant,
  settings: { ...storefrontBlockDefault(slot, variant).settings, ...settings },
});

/** Every desktop menu, with the settings that change its structure. */
const DESKTOP_MENUS: Choice[] = [
  choice("desktopNav", "dropdown"),
  choice("desktopNav", "cascading"),
  choice("desktopNav", "mega-panel"),
  choice("desktopNav", "mega-panel", { promoImages: true }),
  choice("desktopNav", "drill-in-drawer"),
  choice("desktopNav", "departments-rail", { open: "home" }),
  choice("desktopNav", "departments-rail", { open: "always" }),
  choice("desktopNav", "sticky-category-bar", { flyouts: "dropdown" }),
  choice("desktopNav", "sticky-category-bar", { flyouts: "cascading" }),
];
const PHONE_MENUS: Choice[] = [
  choice("mobileNav", "accordion-drawer"),
  choice("mobileNav", "drill-in-drawer"),
  choice("mobileNav", "bottom-tabs"),
  choice("mobileNav", "bottom-tabs", { tabs: ["home", "categories", "offers", "compare", "account"], drawer: "drill-in" }),
];
const HEADERS = storefrontBlockVariants("header");

/**
 * Pairwise: every desktop menu with every header, and the phone menu turning
 * with both, so each pair of (desktop, phone, header) renders at least once.
 */
const NAVIGATION_MATRIX = DESKTOP_MENUS.flatMap((desktop, desktopIndex) =>
  HEADERS.map((header, headerIndex) => ({ desktop, header, phone: PHONE_MENUS[(desktopIndex + headerIndex) % PHONE_MENUS.length]! })),
).map((entry) => ({
  ...entry,
  name: `${entry.desktop.variant}${JSON.stringify(entry.desktop.settings)} / ${entry.phone.variant}${JSON.stringify(entry.phone.settings)} / ${entry.header}`,
}));

function navigationTheme(entry: { desktop: Choice; phone: Choice; header: string }): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  theme.blocks.desktopNav = entry.desktop as never;
  theme.blocks.mobileNav = entry.phone as never;
  theme.blocks.header = storefrontBlockDefault("header", entry.header) as never;
  const parsed = storefrontThemeDocumentSchema.parse(theme);
  // The test store fits every variant, so each renders as itself.
  const { resolved } = requestThemeFor(parsed, STORE_SHAPE);
  expect(resolved.blocks.desktopNav.variant).toBe(entry.desktop.variant);
  expect(resolved.blocks.header.variant).toBe(entry.header);
  return parsed;
}

async function renderNavigationPage(
  theme: StorefrontThemeDocument,
  props: object = {},
  url = CURRENT_PAGE,
  navigation: unknown[] = NAVIGATION,
): Promise<Document> {
  const data = { ...layoutData({ business: true }), navigation };
  return parse(
    await render(
      "/src/layouts/Layout.astro",
      theme,
      { title: "Silk sarees", layoutData: data, ...props },
      { default: '<section class="max-w-7xl mx-auto"><h1>Silk sarees</h1></section>' },
      url,
    ),
  );
}

/** Every disclosure button controls an existing panel whose visibility matches. */
function assertDisclosures(page: Document) {
  const buttons = Array.from(page.querySelectorAll("button[data-disclosure]"));
  for (const button of buttons) {
    const expanded = button.getAttribute("aria-expanded");
    expect(["true", "false"]).toContain(expanded);
    const panel = page.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(panel, button.outerHTML).not.toBeNull();
    expect(panel!.hasAttribute("hidden")).toBe(expanded === "false");
    // An icon-only toggle still has a name.
    expect(button.textContent?.trim()).not.toBe("");
  }
  // <details> menus: every summary has a name, every level a panel.
  for (const menu of Array.from(page.querySelectorAll("details[data-menu]"))) {
    const summary = menu.querySelector(":scope > summary")!;
    expect(summary.textContent?.trim()).not.toBe("");
    expect(menu.querySelector(":scope > [data-menu-panel]")).not.toBeNull();
    expect(menu.closest("[data-menu-root]")).not.toBeNull();
  }
  expect(page.querySelector('[role="menu"], [role="menubar"], [role="menuitem"]')).toBeNull();
  return buttons;
}

const expanded = (page: Document, panelId: string) =>
  page.querySelector(`[aria-controls="${panelId}"]`)?.getAttribute("aria-expanded");

/** Anchors in the header HTML (the drawers and tab bar included). */
function headerLinks(page: Document): number {
  return page.querySelectorAll("#site-header a[href]").length;
}

describe("navigation", () => {
  it.each(NAVIGATION_MATRIX)("$name", async (entry) => {
    const theme = navigationTheme(entry);
    const { layout } = requestThemeFor(theme, STORE_SHAPE);
    const page = await renderNavigationPage(theme);
    expect(duplicateIds(page)).toEqual([]);
    const header = page.querySelector("#main-header")!;
    const siteHeader = page.querySelector("#site-header")!;
    expect(header.getAttribute("data-navigation")).toBe(layout.navigation);
    expect(siteHeader.getAttribute("data-desktop-nav")).toBe(entry.desktop.variant);
    expect(headerLinks(page)).toBeLessThanOrEqual(HEADER_LINK_BUDGET);
    const popups = assertDisclosures(page).filter((button) => button.getAttribute("data-disclosure") === "popup");
    const classic = entry.header === "mall-departments";
    const desktop = entry.desktop.variant;
    const railAlways = desktop === "departments-rail" && entry.desktop.settings.open === "always";

    // Dropdown and mega panels (the version 3 menus): one row, split link and
    // button; row items that don't fit move into "More" in the browser.
    const v3 = desktop === "dropdown" || desktop === "mega-panel";
    expect(Boolean(page.querySelector("#desktop-nav"))).toBe(v3);
    const condensed = classic && desktop === "dropdown";
    expect(header.hasAttribute("data-header-condense")).toBe(condensed);
    expect(Boolean(header.querySelector("[data-nav-compact-from='desktop-nav']"))).toBe(condensed);
    // The scroll reserve under the sticky header is the variant's data.
    const reserve = headerCondense(classic ? null : headerSpec(entry.header, {}), { foldsMenuRow: condensed });
    expect(siteHeader.getAttribute("style")).toContain(`--hdr-condense-phone: ${reserve.phone}`);
    expect(siteHeader.getAttribute("style")).toContain(`--hdr-condense-desktop: ${reserve.desktop}`);
    if (v3) {
      const nav = page.querySelector("#desktop-nav")!;
      expect(nav.getAttribute("data-nav-style")).toBe(desktop === "dropdown" ? "menu" : "mega");
      // Women (split link + button), Men (button only), More; Sale is a link.
      expect(popups.filter((button) => nav.contains(button))).toHaveLength(3);
      expect(nav.querySelector('a[href="/categories/women"]')!.getAttribute("aria-current")).toBe("true");
      expect(nav.querySelector('a[href="/sale"]')!.hasAttribute("aria-current")).toBe(false);
      // The server sends no "More" copies of row items: the browser moves them there.
      const list = nav.querySelector<HTMLElement>("[data-nav-overflow]")!;
      expect(list.querySelectorAll("#desktop-nav-more a")).toHaveLength(0);
      assertOverflowMoves(list);
    }
    if (desktop === "dropdown") {
      // Third level nested under its parent inside the dropdown.
      const dropdown = page.querySelector("#desktop-nav-panel-0")!;
      expect(dropdown.classList.contains("desktop-nav-dropdown")).toBe(true);
      expect(dropdown.querySelector(".nav-dropdown-sublist a[href='/categories/silk-sarees']")!.getAttribute("aria-current")).toBe("page");
      expect(page.querySelector(".mega-panel")).toBeNull();
    }
    if (desktop === "mega-panel") {
      const women = page.querySelector("#desktop-nav-panel-0")!;
      const men = page.querySelector("#desktop-nav-panel-1")!;
      expect(women.classList.contains("mega-panel")).toBe(true);
      // A second-level item with links is a column headed by its link;
      // second-level items without links share plain columns.
      const columns = Array.from(women.querySelectorAll(".mega-column"));
      expect(columns.map((column) => column.querySelector(".mega-column-title")?.textContent ?? null)).toEqual(["Sarees", null]);
      expect(columns[1]!.querySelector('.mega-links a[href="/categories/kurtis"]')).not.toBeNull();
      const promo = entry.desktop.settings.promoImages === true;
      const silk = women.querySelector('a[href="/categories/silk-sarees"]')!;
      // Promo tiles take a linked item with a photo out of its column (same link count).
      expect(silk.classList.contains("mega-promo-tile")).toBe(promo);
      expect(women.querySelectorAll('a[href="/categories/silk-sarees"]')).toHaveLength(1);
      expect(columns[0]!.querySelector('.mega-links a[href="/categories/cotton-sarees"]')).not.toBeNull();
      // Photos only in tiles: small, lazy, decorative, fixed size.
      expect(women.querySelectorAll(".mega-panel img, img").length).toBe(promo ? 1 : 0);
      for (const photo of Array.from(page.querySelectorAll(".mega-panel img"))) {
        expect(photo.getAttribute("alt")).toBe("");
        expect(photo.getAttribute("loading")).toBe("lazy");
        expect(photo.getAttribute("width")).toBeTruthy();
        expect(photo.getAttribute("height")).toBeTruthy();
      }
      // "View all" closes a panel whose parent has a link.
      expect(women.querySelector(".mega-foot .mega-shop-all")!.getAttribute("href")).toBe("/categories/women");
      expect(women.querySelector(".mega-foot")!.textContent).toContain("View all Women");
      expect(men.querySelector(".mega-shop-all")).toBeNull();
    }

    // Cascading and the category bar: <details> levels (no JavaScript
    // needed), fly-outs or indented lists, "Show all" at a column's end.
    const detailsBar = desktop === "cascading" ? "#cascading-nav" : desktop === "sticky-category-bar" ? "#category-bar" : null;
    if (detailsBar) {
      const nav = page.querySelector(detailsBar)!;
      expect(nav.hasAttribute("data-menu-root")).toBe(true);
      expect(nav.querySelector("[data-menu-bar]")).not.toBeNull();
      const women = nav.querySelector('[data-nav-index="0"]')!;
      expect(women.querySelector(":scope > a[href='/categories/women']")!.getAttribute("aria-current")).toBe("true");
      const womenMenu = women.querySelector(":scope > details[data-menu='popup']")!;
      expect(womenMenu.hasAttribute("open")).toBe(false);
      expect(womenMenu.querySelector(":scope > summary .sr-only")!.textContent).toBe("Women submenu");
      const cascade = desktop === "cascading" || entry.desktop.settings.flyouts === "cascading";
      // Sarees: a fly-out (cascade) or an indented list (dropdown).
      const sareesFlyout = womenMenu.querySelector("[data-menu-panel] details[data-menu] [data-menu-panel]");
      expect(Boolean(sareesFlyout)).toBe(cascade);
      if (cascade) {
        expect(sareesFlyout!.querySelector("a[href='/categories/silk-sarees']")!.getAttribute("aria-current")).toBe("page");
        expect(sareesFlyout!.querySelector(".fly-row--all a")!.textContent).toContain("Show all Sarees");
      } else {
        expect(womenMenu.querySelector(".fly-list--nested a[href='/categories/silk-sarees']")).not.toBeNull();
      }
      // A parent without a link opens from its name.
      expect(nav.querySelector('[data-nav-index="1"] > details > summary')!.textContent).toContain("Men");
      // Row items that don't fit move into "More" in the browser.
      const list = nav.querySelector<HTMLElement>("[data-nav-overflow]")!;
      expect(list.querySelector("[data-nav-more-list] a")).toBeNull();
      assertOverflowMoves(list);
    }
    // The category bar is the sticky row of a composed header.
    if (desktop === "sticky-category-bar" && !classic) {
      expect(header.getAttribute("data-hdr-sticky")).toBe("menu-row");
      expect(header.querySelector(".hdr-menu-row [data-category-bar]")).not.toBeNull();
    }
    if (entry.header === "spec-two-row" && !railAlways) {
      expect(header.getAttribute("data-hdr-sticky")).toBe("menu-row");
    }

    // Departments rail open on "home": a tab with its list, open only on the home page.
    const rail = page.querySelector(".drail details");
    expect(Boolean(rail)).toBe(desktop === "departments-rail" && !railAlways);
    if (rail) {
      expect(rail.hasAttribute("open")).toBe(false);
      expect(rail.getAttribute("data-menu")).toBe("popup");
      expect(rail.hasAttribute("data-menu-hover")).toBe(true);
      expect(rail.querySelector("[data-menu-panel] a[href='/categories/women']")).not.toBeNull();
    }

    // Departments rail always open: beside <main> in the shell; the current section expanded.
    const sidebar = page.querySelector("#sidebar-nav");
    const shell = page.querySelector(".site-shell")!;
    expect(shell.contains(page.querySelector("main"))).toBe(true);
    expect(Boolean(sidebar)).toBe(railAlways);
    expect(shell.getAttribute("data-site-shell")).toBe(railAlways ? "sidebar" : null);
    if (sidebar) {
      expect(layout.navigation).toBe("sidebar");
      expect(sidebar.parentElement).toBe(shell);
      expect(expanded(page, "sidebar-nav-0-panel")).toBe("true");
      expect(expanded(page, "sidebar-nav-0-0-panel")).toBe("true");
      expect(expanded(page, "sidebar-nav-1-panel")).toBe("false");
      expect(sidebar.querySelector('a[href="/categories/silk-sarees"]')!.getAttribute("aria-current")).toBe("page");
      // No second copy of the menu in the header on computers.
      expect(header.querySelector("[data-menu-root], #desktop-nav")).toBeNull();
    }

    // Phone menu: the accordion or the drill-in levels.
    const phoneDrill =
      entry.phone.variant === "drill-in-drawer" || (entry.phone.variant === "bottom-tabs" && entry.phone.settings.drawer === "drill-in");
    const phonePanel = page.querySelector("#mobile-menu-panel")!;
    expect(phonePanel.getAttribute("role")).toBe("dialog");
    if (phoneDrill) {
      assertDrill(phonePanel);
      expect(phonePanel.querySelector("[data-disclosure='tree']")).toBeNull();
    } else {
      // The accordion opens on the current section.
      expect(expanded(page, "mobile-nav-0-panel")).toBe("true");
      expect(expanded(page, "mobile-nav-1-panel")).toBe("false");
    }
    expect(page.querySelector("#mobile-menu-panel [data-menu-toggle]")).toBeNull();

    // Drill-in on computers: a button opens a drawer (the phone drawer itself
    // when both drill in); it is a link to the drawer's :target first.
    const trigger = page.querySelector("[data-drawer-open]");
    expect(Boolean(trigger)).toBe(desktop === "drill-in-drawer");
    if (trigger) {
      const panelId = trigger.getAttribute("aria-controls")!;
      expect(trigger.getAttribute("href")).toBe(`#${panelId}`);
      expect(panelId).toBe(phoneDrill ? "mobile-menu-panel" : "nav-drawer-panel");
      const drawer = page.getElementById(panelId)!;
      expect(drawer.getAttribute("data-drawer-screens")).toBe("all");
      assertDrill(drawer);
      expect(trigger.textContent).toContain(entry.header === "retail-pill" ? "Categories" : "All");
    } else {
      expect(page.querySelector("#nav-drawer-panel")).toBeNull();
    }

    // Tab bar only for bottom tabs; the header drops the icons the tabs carry.
    const tabs = page.querySelector("#mobile-tab-bar");
    const bottomTabs = entry.phone.variant === "bottom-tabs";
    expect(Boolean(tabs)).toBe(bottomTabs);
    expect(page.documentElement.getAttribute("data-mobile-nav")).toBe(bottomTabs ? "tabs" : null);
    if (tabs) {
      const chosen = entry.phone.settings.tabs as string[];
      const labels = Array.from(tabs.querySelectorAll(".mobile-tab")).map(
        (item) => item.querySelector(":scope > span:last-child")!.textContent,
      );
      // Compare waits for the compare page: left out, never a dead tab.
      const expectedLabels = chosen
        .filter((tab) => tab !== "compare")
        .map((tab) => tab.charAt(0).toUpperCase() + tab.slice(1));
      expect(labels).toEqual(expectedLabels);
      const categories = tabs.querySelector("[data-mobile-menu-open]")!;
      expect(categories.getAttribute("aria-controls")).toBe("mobile-menu-panel");
      expect(categories.getAttribute("aria-expanded")).toBe("false");
      expect(categories.getAttribute("aria-current")).toBe("true");
      // Every tab is a link first (works before hydration).
      for (const tab of Array.from(tabs.querySelectorAll(".mobile-tab"))) expect(tab.getAttribute("href")).toBeTruthy();
      expect(tabs.querySelector('a[href="/"]')!.hasAttribute("aria-current")).toBe(false);
      const drop = header.getAttribute("data-phone-drop") ?? "";
      expect(drop.includes("account")).toBe(chosen.includes("account"));
      expect(drop.includes("cart")).toBe(chosen.includes("cart"));
      if (chosen.includes("cart")) expect(tabs.querySelector("[data-cart-open] #mobile-cart-count")).not.toBeNull();
    } else {
      expect(page.querySelector("#mobile-cart-count")).toBeNull();
      expect(header.hasAttribute("data-phone-drop")).toBe(false);
    }
  });

  it("keeps the header within 150 links for a Star Tech-size tree, whatever the menus", async () => {
    for (const desktop of DESKTOP_MENUS) {
      for (const phone of PHONE_MENUS) {
        for (const header of ["mall-departments", "marketplace-search", "spec-two-row"]) {
          const theme = navigationTheme({ desktop, phone, header });
          const page = await renderNavigationPage(theme, {}, "https://shop.test/", HUGE_NAVIGATION);
          const name = `${desktop.variant}${JSON.stringify(desktop.settings)} / ${phone.variant} / ${header}`;
          expect(headerLinks(page), name).toBeLessThanOrEqual(HEADER_LINK_BUDGET);
          // Every department stays reachable; deeper levels live on their pages.
          const hrefs = new Set(Array.from(page.querySelectorAll("#site-header a[href]")).map((link) => link.getAttribute("href")));
          for (let top = 0; top < 18; top += 1) expect(hrefs.has(`/categories/d${top}`), `${name} d${top}`).toBe(true);
          const sidebar = page.querySelector("#sidebar-nav");
          if (sidebar) expect(sidebar.querySelectorAll("a[href]").length).toBeLessThanOrEqual(HEADER_LINK_BUDGET);
        }
      }
    }
  }, 120_000);

  it("renders the category tree as departments at scale: each target once, every surface capped, within the budget", async () => {
    // 25 departments x 5 x 1 x 1 (the 30k seed's tree), top levels first, as the layout serves it.
    const nodes: Array<{ id: string; name: string; slug: string; parentId: string | null; canonicalPath: null; imageUrl: null }> = [];
    const node = (id: string, name: string, parentId: string | null) =>
      nodes.push({ id, name, slug: id, parentId, canonicalPath: null, imageUrl: null });
    for (let root = 0; root < 25; root += 1) node(`r${root}`, root === 3 ? "Desk & Mobile Tech Accessories" : `Department ${root}`, null);
    for (let root = 0; root < 25; root += 1) for (let group = 0; group < 5; group += 1) node(`r${root}-${group}`, `Group ${root}.${group}`, `r${root}`);
    for (let root = 0; root < 25; root += 1) for (let group = 0; group < 5; group += 1) node(`r${root}-${group}-l`, `Leaf ${root}.${group}`, `r${root}-${group}`);
    // The live store's flat menu: a repeated department and its own "Track your order".
    const menu = [
      { title: "Shop", href: "/search" },
      { title: "Footwear", href: "/categories/r0" },
      { title: "Footwear", href: "/categories/r0" },
      { title: "Track your order", href: "/track-order" },
    ];
    const shape = storeShapeFromFacts({
      productCount: 1000,
      skuCount: 1000,
      topCategoryCount: 25,
      categoryDepth: 3,
      menu: menu.map(() => ({ subMenu: null })),
      hasCollections: true,
      hasDeliveryMethods: true,
    });
    for (const template of ["marketplace", "mass-retail", "spec-catalogue", "fashion-value", "heritage-editorial", "department-mall", "daily-essentials", "rounded-tech"] as const) {
      const theme = storefrontTemplateTheme(template);
      const { resolved } = requestThemeFor(theme, shape);
      const html = await render(
        "/src/layouts/Layout.astro",
        theme,
        { title: "Home", layoutData: { ...layoutData({ business: true }), navigation: menu, categoryTree: { nodes, truncated: false } } },
        undefined,
        "https://shop.test/",
        shape,
      );
      const page = parse(html);
      const site = page.querySelector("#site-header")!;
      expect(site.getAttribute("data-nav-source"), template).toBe(resolved.blocks.navigation.source);
      expect(headerLinks(page), template).toBeLessThanOrEqual(resolved.blocks.navigation.linkBudget);
      expect(duplicateIds(page), template).toEqual([]);
      // The phone drawer: at most maxTopItems departments, each once, then "All categories".
      const drawer = page.querySelector("#mobile-menu-panel")!;
      expect(drawer.querySelector("h2")!.textContent, template).toBe("Shop by department");
      const roots = Array.from(
        drawer.querySelectorAll(":scope nav .drill > .drill-list > .drill-row, :scope nav .nav-tree:not(.nav-tree--nested) > li"),
      ).map((row) => (row.querySelector("a, summary")!.textContent ?? "").replace(/\s+/g, " ").trim());
      expect(roots.at(-1), template).toBe("All categories");
      expect(roots.length - 1, template).toBe(Math.min(resolved.blocks.navigation.maxTopItems, 27));
      expect(new Set(roots).size, template).toBe(roots.length);
      expect(drawer.querySelectorAll('a[href="/track-order"]').length, template).toBeLessThanOrEqual(1);
      // The desktop row: at most maxTopItems items, the rest named in "More", never a department twice.
      const row = page.querySelector("#site-header [data-nav-overflow]:not(#drill-row-nav [data-nav-overflow])");
      if (row && !row.closest("#drill-row-nav")) {
        expect(row.querySelectorAll(":scope > [data-nav-index]").length, template).toBeLessThanOrEqual(resolved.blocks.navigation.maxTopItems);
        const more = Array.from(row.querySelectorAll("[data-nav-more-list] > li > a")).map((link) => link.textContent!.trim());
        expect(more.at(-1), template).toBe("All categories");
        const rowLabels = Array.from(row.querySelectorAll(":scope > [data-nav-index] > a")).map((link) => link.textContent!.trim());
        expect(new Set([...rowLabels, ...more]).size, template).toBe(rowLabels.length + more.length);
      }
      // The long name is whole in the HTML (the browser fits it or moves it into "More").
      expect(page.querySelector('#site-header a[href="/categories/r3"]')!.textContent!.trim()).toBe("Desk & Mobile Tech Accessories");
    }
  }, 120_000);

  it("opens the departments rail over the hero on the home page only", async () => {
    const theme = navigationTheme({
      desktop: choice("desktopNav", "departments-rail", { open: "home" }),
      phone: choice("mobileNav", "accordion-drawer"),
      header: "mall-departments",
    });
    const home = await renderNavigationPage(theme, {}, "https://shop.test/");
    const rail = home.querySelector(".drail details")!;
    expect(rail.hasAttribute("open")).toBe(true);
    expect(rail.getAttribute("data-menu")).toBe("rail");
    expect(rail.hasAttribute("data-menu-home-open")).toBe(true);
    expect(rail.hasAttribute("data-menu-hover")).toBe(false);
  });

  it("keeps the sidebar and tab bar off checkout, cart and focused pages", async () => {
    const theme = navigationTheme({
      desktop: choice("desktopNav", "departments-rail", { open: "always" }),
      phone: choice("mobileNav", "bottom-tabs"),
      header: "mall-departments",
    });
    // Cart and checkout render without the header.
    const checkout = await renderNavigationPage(theme, { hideHeader: true, hideFooter: true }, "https://shop.test/checkout");
    expect(checkout.querySelector("#sidebar-nav")).toBeNull();
    expect(checkout.querySelector("#mobile-tab-bar")).toBeNull();
    expect(checkout.querySelector(".site-shell")!.hasAttribute("data-site-shell")).toBe(false);
    expect(checkout.documentElement.hasAttribute("data-mobile-nav")).toBe(false);

    const receipt = await renderNavigationPage(theme, { hideNavigationSidebar: true }, "https://shop.test/order-success");
    expect(receipt.querySelector("#sidebar-nav")).toBeNull();
    expect(receipt.querySelector("#mobile-tab-bar")).not.toBeNull();

    const home = await renderNavigationPage(theme, {}, "https://shop.test/");
    expect(home.querySelector('#mobile-tab-bar a[href="/"]')!.getAttribute("aria-current")).toBe("page");
    expect(home.querySelector("#mobile-tab-bar [data-mobile-menu-open]")!.hasAttribute("aria-current")).toBe(false);
    expect(expanded(home, "sidebar-nav-0-panel")).toBe("false");
  });
});

/** A row that is too narrow moves its last items, whole, into "More" and back. */
function assertOverflowMoves(list: HTMLElement) {
  const items = Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-nav-index]"));
  const width = (element: Element, value: number) => Object.defineProperty(element, "offsetWidth", { configurable: true, value });
  items.forEach((item) => width(item, 100));
  width(list.querySelector("[data-nav-more]")!, 60);
  const links = list.querySelectorAll("a").length;
  Object.defineProperty(list, "clientWidth", { configurable: true, value: 170 });
  fitNavOverflow(list);
  expect(list.querySelectorAll(":scope > [data-nav-index]")).toHaveLength(1);
  expect(list.querySelectorAll("[data-nav-more-list] > [data-nav-index]")).toHaveLength(items.length - 1);
  expect(list.querySelectorAll("a")).toHaveLength(links);
  Object.defineProperty(list, "clientWidth", { configurable: true, value: 1000 });
  fitNavOverflow(list);
  expect(list.querySelectorAll(":scope > [data-nav-index]")).toHaveLength(items.length);
}

/** A drill-in drawer: levels as <details>, each opening on "All <parent>". */
function assertDrill(drawer: Element) {
  const drill = drawer.querySelector(".drill[data-menu-root]")!;
  expect(drill).not.toBeNull();
  const women = drill.querySelector(":scope > .drill-list > .drill-row > details[data-menu='drill']")!;
  expect(women.querySelector(":scope > summary")!.textContent).toContain("Women");
  expect(women.hasAttribute("open")).toBe(false);
  const level = women.querySelector(":scope > [data-menu-panel]")!;
  expect(level.querySelector(":scope > .drill-list > .drill-row:first-child a")!.getAttribute("href")).toBe("/categories/women");
  expect(level.querySelector("details[data-menu='drill'] a[href='/categories/silk-sarees']")!.getAttribute("aria-current")).toBe("page");
  // A linkless parent has no "All" row, only its children.
  const men = Array.from(drill.querySelectorAll(":scope > .drill-list > .drill-row > details")).find((node) =>
    node.querySelector("summary")!.textContent!.includes("Men"),
  )!;
  expect(men.querySelector("[data-menu-panel] .drill-link--all")).toBeNull();
  // Sibling levels are one open group (exclusive <details name>).
  const names = Array.from(drill.querySelectorAll(":scope > .drill-list > .drill-row > details")).map((node) => node.getAttribute("name"));
  expect(new Set(names).size).toBe(1);
}

// ─── Sections in any order, repeated rich text ────────────────────────────

describe("theme sections", () => {
  const base = storefrontTemplateTheme("heritage-editorial");
  const custom = storefrontThemeDocumentSchema.parse({
    ...base,
    pages: {
      home: [
        {
          id: "story",
          type: "editorial",
          version: 1,
          settings: {
            layout: "rich-text",
            heading: "Our story",
            body: "Woven by hand in Tangail.\n\nEvery saree takes <b>two weeks</b>.\nAsk us anything.",
          },
        },
        { id: "hero", type: "hero", version: 1, settings: { layout: "full-screen" } },
        { id: "collections", type: "collections", version: 1, settings: {} },
        { id: "care", type: "editorial", version: 1, settings: { layout: "rich-text", heading: "", body: "Dry clean only." } },
        // Waits for a subscriber list: renders nothing.
        { id: "brands", type: "newsletter", version: 1, settings: { heading: "Join", text: "" } },
        { id: "delivery", type: "usp-strip", version: 1, settings: { style: "icons", source: { kind: "delivery-facts" } } },
      ],
    },
  });

  it("renders sections in document order with rich text as escaped plain text", async () => {
    // Rich text above the hero is a short strip: the hero photo still leads.
    const leadSectionId = homepageLeadSection(custom.pages.home, HOMEPAGE_CONTENT)?.id ?? null;
    expect(leadSectionId).toBe("hero");
    const html = await render("/src/components/homepage/HomepageSections.astro", custom, {
      ...HOMEPAGE_PROPS,
      sections: custom.pages.home,
      leadSectionId,
    });
    const page = parse(html);
    expect(
      Array.from(page.querySelectorAll("[data-home-section]")).map((node) => node.getAttribute("data-section-id")),
    ).toEqual(["story", "hero", "collections", "care", "delivery"]);
    expect(duplicateIds(page)).toEqual([]);

    const story = page.querySelector('[data-section-id="story"] section')!;
    const heading = story.querySelector("h2")!;
    expect(heading.textContent).toBe("Our story");
    expect(story.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(Array.from(story.querySelectorAll("p")).map((node) => node.textContent)).toEqual([
      "Woven by hand in Tangail.",
      "Every saree takes <b>two weeks</b>.\nAsk us anything.",
    ]);
    expect(story.querySelector("b")).toBeNull();

    const care = page.querySelector('[data-section-id="care"] section')!;
    expect(care.querySelector("h2")).toBeNull();
    expect(care.getAttribute("aria-label")).toBe("Store information");

    // The hero holds the first large photo, so it gets high priority.
    expect(page.querySelector(".desktop-carousel img")!.getAttribute("fetchpriority")).toBe("high");
    // The categories section is absent in this custom document.
    expect(page.querySelector("#homepage-category-rail-title")).toBeNull();
  });

  it("skips empty sections and text strips when choosing what leads", () => {
    expect(
      homepageLeadSection(custom.pages.home, { ...HOMEPAGE_CONTENT, hero: NO_HERO })?.id,
    ).toBe("collections");
    expect(homepageLeadSection(custom.pages.home, { ...HOMEPAGE_CONTENT, hero: NO_HERO, collections: [], lists: new Map() })).toBeNull();
    const emptyStory = custom.pages.home.map((section) =>
      section.type === "editorial" ? { ...section, settings: { layout: "rich-text" as const, heading: " ", body: "\n\n" } } : section,
    );
    expect(homepageLeadSection(emptyStory, HOMEPAGE_CONTENT)?.id).toBe("hero");
    expect(homepageLeadSection(emptyStory, { ...HOMEPAGE_CONTENT, hero: NO_HERO })?.id).toBe("collections");
  });
});
