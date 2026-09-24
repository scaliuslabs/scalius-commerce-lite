// @vitest-environment node
/**
 * Render-only theme coverage (no browser): renders the real storefront Astro
 * components with Astro's container API, through a Vite dev server in
 * middleware mode, for every Style preset with every layout choice, and checks
 * the markup invariants each choice promises. Layout, overlap, contrast and
 * LCP timing need a browser; this catches wrong markup cheaply in CI.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import {
  STOREFRONT_CARD_STYLES,
  STOREFRONT_FOOTER_STYLES,
  STOREFRONT_DENSITIES,
  buildStorefrontThemeTokens,
  STOREFRONT_HEADER_STYLES,
  STOREFRONT_MOBILE_NAVIGATION_STYLES,
  STOREFRONT_NAVIGATION_STYLES,
  STOREFRONT_PRODUCT_PAGE_LAYOUTS,
  STOREFRONT_STYLE_PRESET_KEYS,
  resolveStorefrontThemeLayout,
  storefrontStylePresetTheme,
  storefrontThemeDocumentSchema,
  type StorefrontThemeDocument,
  type StorefrontThemeLayout,
} from "@scalius/shared/storefront-theme";
import {
  productCardImageSizes,
  productGridFirstRow,
  productGridFluidCss,
} from "@/lib/product-card-layout";
import { homepageLeadSection } from "@/lib/homepage-sections";
import {
  productGalleryMainSlot,
  productGalleryThumbnailSlot,
} from "@/components/product/lib/gallery-images";

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
): Promise<string> {
  const requestTheme = {
    theme,
    layout: resolveStorefrontThemeLayout(theme.layout),
    previewToken: null,
    preview: null,
  };
  return container.renderToString(await component(path), {
    props,
    slots,
    // The shape lib/storefront-theme-context keeps per request.
    locals: { storefrontTheme: Promise.resolve(requestTheme) },
    request: new Request(url),
  });
}

const window = new Window();
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

const HOMEPAGE_PROPS = {
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
  fallbackProducts: [],
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
  currencySymbol: "৳",
  currencyCode: "BDT",
};
const HOMEPAGE_CONTENT = { hero: true, collections: true, categories: true, delivery: true };

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

// ─── The matrix: every Style preset with every layout choice ─────────────

// Navigation has its own matrix below (every style with every header style),
// which renders only the Layout, so this one stays fast.
type MatrixAxis = Exclude<keyof StorefrontThemeLayout, "navigation" | "mobileNavigation">;
const LAYOUT_CHOICES: { [Axis in MatrixAxis]: readonly StorefrontThemeLayout[Axis][] } = {
  header: STOREFRONT_HEADER_STYLES,
  footer: STOREFRONT_FOOTER_STYLES,
  card: STOREFRONT_CARD_STYLES,
  density: STOREFRONT_DENSITIES,
  productPage: STOREFRONT_PRODUCT_PAGE_LAYOUTS,
};

const MATRIX = (() => {
  const seen = new Set<string>();
  return STOREFRONT_STYLE_PRESET_KEYS.flatMap((preset) =>
    Object.entries(LAYOUT_CHOICES).flatMap(([axis, values]) =>
      values.map((value) => {
        const base = storefrontStylePresetTheme(preset);
        const theme = storefrontThemeDocumentSchema.parse({ ...base, layout: { ...base.layout, [axis]: value } });
        const key = `${preset} ${JSON.stringify(theme.layout)}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return { name: `${preset}: ${Object.values(theme.layout).join(" / ")}`, theme };
      }),
    ).filter((entry): entry is { name: string; theme: StorefrontThemeDocument } => entry !== null),
  );
})();

describe("storefront theme render matrix", () => {
  it("covers every preset with every layout choice", () => {
    for (const [axis, values] of Object.entries(LAYOUT_CHOICES)) {
      for (const preset of STOREFRONT_STYLE_PRESET_KEYS) {
        const rendered = new Set(
          MATRIX.filter((entry) => entry.name.startsWith(`${preset}:`)).map(
            (entry) => entry.theme.layout[axis as keyof StorefrontThemeLayout],
          ),
        );
        expect([...rendered].sort()).toEqual([...values].sort());
      }
    }
  });

  it.each(MATRIX)("$name", async ({ theme }) => {
    const layout = resolveStorefrontThemeLayout(theme.layout);
    const leadSectionId = homepageLeadSection(theme.sections, HOMEPAGE_CONTENT)?.id ?? null;

    // Homepage inside the full Layout (header, footer, mobile menu).
    const homepage = await render("/src/components/homepage/HomepageSections.astro", theme, {
      ...HOMEPAGE_PROPS,
      sections: theme.sections,
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
    expect(body.dataset.themeDensity).toBe(layout.density);
    expect(body.dataset.themeCardStyle).toBe(theme.tokens.components.cards);
    expect(body.hasAttribute("data-theme-grid-desktop")).toBe(false);
    // The density's grid tokens and fluid steps reach :root.
    const themeCss = Array.from(page.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .find((text) => text.startsWith(":root, .site-root"))!;
    const fluid = productGridFluidCss(layout.grid);
    expect(themeCss).toContain(`--theme-card-min-phone: ${layout.grid.cardMin.phone}`);
    expect(themeCss).toContain(`--grid-card-min-fluid: ${fluid.cardMin}`);
    expect(themeCss).toContain(`--grid-gap-fluid: ${fluid.gap}`);
    // Every product grid sits in its container frame.
    const grids = Array.from(page.querySelectorAll(".product-grid"));
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) expect(grid.parentElement!.classList.contains("product-grid-frame")).toBe(true);

    // Header style; the marketplace search row replaces the phone search icon.
    const header = page.querySelector("#main-header")!;
    expect(header.getAttribute("data-header-style")).toBe(layout.header);
    const marketplace = layout.header === "marketplace";
    expect(Boolean(page.querySelector("#mobile-search-trigger"))).toBe(marketplace);
    expect(page.querySelector("#mobile-search-toggle")!.classList.contains("hidden")).toBe(marketplace);
    // The row that condenses on scroll, and the search row that folds away.
    expect(header.querySelector(".header-row")).not.toBeNull();
    expect(Boolean(header.querySelector(".header-mobile-search #mobile-search-trigger"))).toBe(marketplace);

    // Homepage sections in document order; the hero leads when it is the
    // first photo section (text strips and category thumbnails above it don't count).
    expect(
      Array.from(page.querySelectorAll("[data-home-section]")).map((node) => node.getAttribute("data-home-section")),
    ).toEqual(theme.sections.map((section) => section.type));
    // The banner's first slide is high priority wherever it sits (one of at
    // most two photo sections, so it is at or just below the fold).
    const heroImage = page.querySelector(".desktop-carousel img")!;
    expect(heroImage.getAttribute("fetchpriority")).toBe("high");
    // Phones get a phone-sized rendition, and the first slide paints without script.
    const phoneSource = page.querySelector(".mobile-carousel [data-slide-index='0'] source")!;
    expect(phoneSource.getAttribute("srcset")).toContain("https://cdn.shop.test/media/m1.jpg/640.webp 640w");
    expect(phoneSource.getAttribute("sizes")).toBe("calc(100vw - 2rem)");
    expect(page.querySelector(".desktop-carousel [data-slide-index='0'] source")!.getAttribute("sizes")).toBeNull();
    expect(page.querySelector(".mobile-carousel [data-slide-index='0']")!.classList.contains("opacity-100")).toBe(true);

    // Footer: the style's structure, with contact links from business facts.
    assertFooter(page, layout.footer, { business: true });
    const bare = parse(
      await render("/src/layouts/Layout.astro", theme, { title: "Home", layoutData: layoutData({ business: false }) }),
    );
    assertFooter(bare, layout.footer, { business: false });

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
});

function assertFooter(page: Document, style: string, options: { business: boolean }) {
  const footer = page.querySelector("footer")!;
  const tel = footer.querySelectorAll('a[href^="tel:"]');
  const whatsapp = footer.querySelectorAll('a[href^="https://wa.me/"]');
  const helpHeading = Array.from(footer.querySelectorAll("h2")).some((node) => node.textContent === "Need help ordering?");
  const compactNav = footer.querySelector('nav[aria-label="Footer"]');
  const menuHeadings = Array.from(footer.querySelectorAll("h2")).map((node) => node.textContent?.trim());

  expect(Boolean(compactNav)).toBe(style === "compact");
  // No store contact detail at all: no empty "Need help ordering?" block (R3-CAT-07).
  expect(helpHeading).toBe(style === "contact" && options.business);
  if (style === "compact") {
    // Every menu link, policy and "Track your order" (placed in the Help
    // menu) in one band, each a 44px target.
    const links = Array.from(compactNav!.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      expect.arrayContaining([
        ...FOOTER_MENUS.flatMap((menu) => menu.links.map((link) => link.href)),
        "/refund-policy",
        "/privacy-policy",
      ]),
    );
    expect(links).toHaveLength(FOOTER_MENUS.length * 5 + 3);
    for (const link of links) expect(link.className).toContain("min-h-11");
  } else {
    expect(menuHeadings).toEqual(expect.arrayContaining(FOOTER_MENUS.map((menu) => menu.title)));
  }
  if (!options.business) {
    expect(tel).toHaveLength(0);
    expect(whatsapp).toHaveLength(0);
    expect(footer.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(footer.querySelector("address")).toBeNull();
    return;
  }
  expect(tel.length).toBeGreaterThan(0);
  expect(whatsapp.length).toBe(style === "contact" ? 1 : 0);
  expect(Boolean(footer.querySelector('a[href^="mailto:"]'))).toBe(style === "contact");
  expect(Boolean(footer.querySelector("address"))).toBe(style === "contact");
}

function assertCards(document: Document, theme: StorefrontThemeDocument) {
  const layout = resolveStorefrontThemeLayout(theme.layout);
  const containerWidth = buildStorefrontThemeTokens(theme)["theme-container-width"]!;
  const firstRow = productGridFirstRow(layout.grid, containerWidth);
  const card = layout.productCard;
  const cards = Array.from(document.querySelectorAll('[data-theme-component="product-card"]'));
  expect(cards).toHaveLength(Object.keys(CARD_PRODUCTS).length);
  const [onSale, withOptions, soldOut, plain] = cards as [Element, Element, Element, Element];

  cards.forEach((element, index) => {
    const media = element.querySelector(".product-card-media")!;
    expect(media.classList.contains(card.imageRatio === "portrait" ? "aspect-[4/5]" : "aspect-square")).toBe(true);
    const photo = media.querySelector("img")!;
    // `sizes` follows the density's fluid grid within the container cap.
    expect(photo.getAttribute("sizes")).toBe(productCardImageSizes(layout.grid, containerWidth));
    expect(photo.getAttribute("sizes")).toMatch(/^\(max-width: \d+px\) calc\(100vw - \d+px\), \(max-width: \d+px\) calc\(50vw - \d+px\), /);
    expect(photo.getAttribute("height")).toBe(card.imageRatio === "portrait" ? "500" : "400");
    // First row eager, a phone row (the first two photos) high priority.
    expect(photo.getAttribute("loading")).toBe(index < firstRow ? "eager" : "lazy");
    expect(photo.getAttribute("fetchpriority")).toBe(index < 2 && index < firstRow ? "high" : "auto");
    // One link per card (the stretched title link) plus at most Buy now.
    const links = element.querySelectorAll("a");
    expect(links.length).toBeLessThanOrEqual(2);
  });

  // Hover photo only for portrait cards (and only with a second photo).
  expect(Boolean(onSale.querySelector(".product-card-hover-image"))).toBe(card.hoverImage);
  expect(Boolean(withOptions.querySelector(".product-card-hover-image"))).toBe(card.hoverImage);
  expect(plain.querySelector(".product-card-hover-image")).toBeNull();

  // Buy now only for quick cards, only in stock without options; it sits
  // above the stretched card link and is a 44px target.
  const buyNow = (element: Element) => element.querySelector('a[href^="/buy/"]');
  expect(Boolean(buyNow(onSale))).toBe(card.quickBuy);
  expect(Boolean(buyNow(plain))).toBe(card.quickBuy);
  expect(buyNow(withOptions)).toBeNull();
  expect(buyNow(soldOut)).toBeNull();
  // Quick cards without Buy now keep its space so prices align across a row.
  const spacer = (element: Element) => element.querySelector("[data-quick-buy-spacer]");
  expect(Boolean(spacer(withOptions))).toBe(card.quickBuy);
  expect(Boolean(spacer(soldOut))).toBe(card.quickBuy);
  expect(spacer(onSale)).toBeNull();
  if (card.quickBuy) {
    expect(buyNow(onSale)!.className).toMatch(/\brelative\b.*\bz-10\b/);
    expect(buyNow(onSale)!.className).toContain("min-h-11");
    // Its accessible name starts with the visible words (WCAG 2.5.3).
    expect(buyNow(onSale)!.hasAttribute("aria-label")).toBe(false);
    expect(buyNow(onSale)!.textContent?.replace(/\s+/g, " ").trim()).toBe("Buy now: Product sale");
  }

  // The discount badge sits on the photo or next to the price.
  const imageBadge = onSale.querySelector(".product-card-media span.bg-destructive");
  const priceBadge = onSale.querySelector("p span.text-destructive");
  expect(Boolean(imageBadge)).toBe(card.badge === "image");
  expect(Boolean(priceBadge)).toBe(card.badge === "price");
  expect(soldOut.textContent).toContain("Sold out");
}

// ─── Navigation: every style with every phone style and header style ─────

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
          { id: "silk", title: "Silk sarees", href: "/categories/silk-sarees" },
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

const NAVIGATION_MATRIX = STOREFRONT_NAVIGATION_STYLES.flatMap((navigation) =>
  STOREFRONT_MOBILE_NAVIGATION_STYLES.flatMap((mobileNavigation) =>
    STOREFRONT_HEADER_STYLES.map((header) => ({ navigation, mobileNavigation, header })),
  ),
);

function navigationTheme(layout: Partial<StorefrontThemeLayout>): StorefrontThemeDocument {
  const base = storefrontStylePresetTheme("classic");
  return storefrontThemeDocumentSchema.parse({ ...base, layout: { ...base.layout, ...layout } });
}

async function renderNavigationPage(
  theme: StorefrontThemeDocument,
  props: object = {},
  url = CURRENT_PAGE,
): Promise<Document> {
  const data = { ...layoutData({ business: true }), navigation: NAVIGATION };
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
  expect(page.querySelector('[role="menu"], [role="menubar"], [role="menuitem"]')).toBeNull();
  return buttons;
}

const expanded = (page: Document, panelId: string) =>
  page.querySelector(`[aria-controls="${panelId}"]`)?.getAttribute("aria-expanded");

describe("navigation styles", () => {
  it.each(NAVIGATION_MATRIX)("$navigation / $mobileNavigation / $header", async (layout) => {
    const page = await renderNavigationPage(navigationTheme(layout));
    expect(duplicateIds(page)).toEqual([]);
    const header = page.querySelector("#main-header")!;
    expect(header.getAttribute("data-navigation")).toBe(layout.navigation);
    const popups = assertDisclosures(page).filter((button) => button.getAttribute("data-disclosure") === "popup");

    // Desktop menu row: menu and mega only; the classic bar folds the dropdown
    // menu into itself on scroll (a second, compact copy).
    const menuRow = layout.navigation === "menu" || layout.navigation === "mega";
    const condensed = layout.navigation === "menu" && layout.header === "classic";
    expect(Boolean(page.querySelector("#desktop-nav"))).toBe(menuRow);
    expect(Boolean(page.querySelector("#desktop-nav-compact"))).toBe(condensed);
    expect(header.hasAttribute("data-header-condense")).toBe(condensed);
    if (menuRow) {
      const nav = page.querySelector("#desktop-nav")!;
      expect(nav.getAttribute("data-nav-style")).toBe(layout.navigation);
      expect(nav.querySelector("[data-nav-overflow]")).not.toBeNull();
      // Women (split link + button), Men (button only), More; Sale is a link.
      expect(popups.filter((button) => nav.contains(button))).toHaveLength(3);
      expect(nav.querySelector('a[href="/categories/women"]')!.getAttribute("aria-current")).toBe("true");
      expect(nav.querySelector('a[href="/sale"]')!.hasAttribute("aria-current")).toBe(false);
      expect(nav.querySelector("#desktop-nav-more [data-nav-more-index='0'] a[href='/categories/sarees']")).not.toBeNull();
    }
    if (layout.navigation === "menu") {
      // Third level nested under its parent inside the dropdown.
      const dropdown = page.querySelector("#desktop-nav-panel-0")!;
      expect(dropdown.classList.contains("desktop-nav-dropdown")).toBe(true);
      expect(dropdown.querySelector(".nav-dropdown-sublist a[href='/categories/silk-sarees']")!.getAttribute("aria-current")).toBe("page");
      expect(page.querySelector(".mega-panel")).toBeNull();
    }
    if (layout.navigation === "mega") {
      const women = page.querySelector("#desktop-nav-panel-0")!;
      const men = page.querySelector("#desktop-nav-panel-1")!;
      expect(women.classList.contains("mega-panel")).toBe(true);
      // One column per second-level item, headed by its link, then its links.
      const columns = Array.from(women.querySelectorAll(".mega-column"));
      expect(columns.map((column) => column.querySelector(".mega-column-title")!.textContent)).toEqual(["Sarees", "Kurtis"]);
      expect(Array.from(columns[0]!.querySelectorAll(".mega-links a")).map((link) => link.getAttribute("href"))).toEqual([
        "/categories/silk-sarees",
        "/categories/cotton-sarees",
      ]);
      // Photos only where the category has one: small, lazy, decorative, fixed size.
      expect(columns[0]!.querySelector("img")!.getAttribute("src")).toBe(image("sarees"));
      expect(columns[1]!.querySelector("img")).toBeNull();
      for (const photo of Array.from(page.querySelectorAll(".mega-panel img"))) {
        expect(photo.getAttribute("alt")).toBe("");
        expect(photo.getAttribute("loading")).toBe("lazy");
        expect(photo.getAttribute("width")).toBeTruthy();
        expect(photo.getAttribute("height")).toBeTruthy();
      }
      // "Shop all" for a parent with a link (on its photo when it has one).
      expect(women.querySelector(".mega-feature")!.getAttribute("href")).toBe("/categories/women");
      expect(women.querySelector(".mega-feature")!.textContent).toContain("Shop all Women");
      expect(men.querySelector(".mega-shop-all")).toBeNull();
      expect(men.querySelector(".mega-column img")!.getAttribute("src")).toBe(image("panjabi"));
    }

    // Pills: one row of top-level links; a parent without a link offers its children.
    const pills = page.querySelector("#pill-nav");
    expect(Boolean(pills)).toBe(layout.navigation === "pills");
    if (pills) {
      expect(header.contains(pills)).toBe(true);
      expect(pills.querySelector("[data-pill-scroller]")).not.toBeNull();
      expect(Array.from(pills.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toEqual([
        "/categories/women",
        "/categories/panjabi",
        "/sale",
      ]);
      expect(pills.querySelector('a[href="/categories/women"]')!.getAttribute("aria-current")).toBe("true");
      expect(pills.querySelector("button")).toBeNull();
    }

    // Sidebar: beside <main> in the shell; the current section renders expanded.
    const sidebar = page.querySelector("#sidebar-nav");
    const shell = page.querySelector(".site-shell")!;
    expect(shell.contains(page.querySelector("main"))).toBe(true);
    expect(Boolean(sidebar)).toBe(layout.navigation === "sidebar");
    expect(shell.getAttribute("data-site-shell")).toBe(layout.navigation === "sidebar" ? "sidebar" : null);
    if (sidebar) {
      expect(sidebar.parentElement).toBe(shell);
      expect(expanded(page, "sidebar-nav-0-panel")).toBe("true");
      expect(expanded(page, "sidebar-nav-0-0-panel")).toBe("true");
      expect(expanded(page, "sidebar-nav-1-panel")).toBe("false");
      expect(sidebar.querySelector('a[href="/categories/silk-sarees"]')!.getAttribute("aria-current")).toBe("page");
    }

    // The phone drawer is an accordion that opens on the current section.
    expect(expanded(page, "mobile-nav-0-panel")).toBe("true");
    expect(expanded(page, "mobile-nav-1-panel")).toBe("false");
    expect(page.querySelector("#mobile-menu-panel [data-menu-toggle]")).toBeNull();

    // Tab bar only for `tabs`, wired to the header's openers.
    const tabs = page.querySelector("#mobile-tab-bar");
    expect(Boolean(tabs)).toBe(layout.mobileNavigation === "tabs");
    expect(page.documentElement.getAttribute("data-mobile-nav")).toBe(layout.mobileNavigation === "tabs" ? "tabs" : null);
    if (tabs) {
      const items = Array.from(tabs.querySelectorAll(".mobile-tab"));
      // Visible labels (the cart count badge is aria-hidden).
      expect(items.map((item) => item.querySelector(":scope > span:last-child")!.textContent)).toEqual([
        "Home",
        "Categories",
        "Search",
        "Cart",
        "Account",
      ]);
      const categories = tabs.querySelector("[data-mobile-menu-open]")!;
      expect(categories.getAttribute("aria-controls")).toBe("mobile-menu-panel");
      expect(categories.getAttribute("aria-expanded")).toBe("false");
      expect(categories.getAttribute("aria-current")).toBe("true");
      expect(tabs.querySelector("[data-search-open]")).not.toBeNull();
      expect(tabs.querySelector("[data-cart-open] #mobile-cart-count")).not.toBeNull();
      expect(tabs.querySelector('a[data-account-link][href="/account"]')).not.toBeNull();
      expect(tabs.querySelector('a[href="/"]')!.hasAttribute("aria-current")).toBe(false);
    } else {
      expect(page.querySelector("#mobile-cart-count")).toBeNull();
    }
  });

  it("keeps the sidebar and tab bar off checkout, cart and focused pages", async () => {
    const theme = navigationTheme({ navigation: "sidebar", mobileNavigation: "tabs" });
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

// ─── Custom mode: builder sections ────────────────────────────────────────

describe("custom theme sections", () => {
  const base = storefrontStylePresetTheme("heritage");
  const custom = storefrontThemeDocumentSchema.parse({
    ...base,
    mode: "custom",
    sections: [
      {
        id: "story",
        type: "rich_text",
        version: 1,
        settings: {
          heading: "Our story",
          body: "Woven by hand in Tangail.\n\nEvery saree takes <b>two weeks</b>.\nAsk us anything.",
        },
      },
      { id: "hero", type: "hero", version: 1, settings: {} },
      { id: "collections", type: "collections", version: 1, settings: {} },
      { id: "care", type: "rich_text", version: 1, settings: { heading: "", body: "Dry clean only." } },
      { id: "delivery", type: "delivery", version: 1, settings: {} },
    ],
  });

  it("renders sections in document order with rich text as escaped plain text", async () => {
    // Rich text above the hero is a short strip: the hero photo still leads.
    const leadSectionId = homepageLeadSection(custom.sections, HOMEPAGE_CONTENT)?.id ?? null;
    expect(leadSectionId).toBe("hero");
    const html = await render("/src/components/homepage/HomepageSections.astro", custom, {
      ...HOMEPAGE_PROPS,
      sections: custom.sections,
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
      homepageLeadSection(custom.sections, { ...HOMEPAGE_CONTENT, hero: false })?.id,
    ).toBe("collections");
    expect(homepageLeadSection(custom.sections, { ...HOMEPAGE_CONTENT, hero: false, collections: false })).toBeNull();
    const emptyStory = custom.sections.map((section) =>
      section.type === "rich_text" ? { ...section, settings: { heading: " ", body: "\n\n" } } : section,
    );
    expect(homepageLeadSection(emptyStory, HOMEPAGE_CONTENT)?.id).toBe("hero");
    expect(homepageLeadSection(emptyStory, { ...HOMEPAGE_CONTENT, hero: false })?.id).toBe("collections");
  });
});
