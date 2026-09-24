// @vitest-environment node
/**
 * The card matrix, render-only: every card variant x density x image ratio
 * x image fit renders the real ProductCard (Astro container API through a
 * Vite dev server in middleware mode) for products that exercise each
 * anatomy: on sale, with options, sold out, without a photo, a long Bangla
 * title, every optional fact, and facts at zero. Layout on real viewports
 * needs a browser; this checks the markup each anatomy promises.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_DENSITIES,
  STOREFRONT_IMAGE_FITS,
  STOREFRONT_IMAGE_RATIOS,
  storefrontBlockDefault,
  storefrontBlockVariants,
  storefrontThemeDocumentSchema,
  type StorefrontCardRenderer,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { requestThemeFor } from "@/lib/storefront-theme-context";
import { CARD_IMAGE_DIMENSIONS, KEY_SPECS_MAX } from "./card-model";

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
let ProductCard: unknown;
let ProductGrid: unknown;

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
          name: "card-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0card-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0card-test:") ? VIRTUAL_MODULES[id.slice("\0card-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  container = await experimental_AstroContainer.create();
  ProductCard = (await server.ssrLoadModule("/src/components/cards/ProductCard.astro")).default;
  ProductGrid = (await server.ssrLoadModule("/src/components/cards/ProductGrid.astro")).default;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const window = new Window();
const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";

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

const BANGLA_TITLE = "হাতে বোনা জামদানি শাড়ি সুতি ও রেশমের মিশ্রণে তৈরি নকশিকাঁথা ফোঁড়ের পাড় সহ উৎসবের জন্য বিশেষ সংস্করণ";

const PRODUCTS = {
  onSale: product("sale", { discountedPrice: 960, discountType: "percentage", discountPercentage: 20, secondaryImageUrl: image("sale-back") }),
  withOptions: product("options", { hasVariants: true, priceVaries: true, secondaryImageUrl: image("options-back") }),
  soldOut: product("soldout", { availableForSale: false }),
  noPhoto: product("nophoto", { imageUrl: null, secondaryImageUrl: image("orphan-back") }),
  bangla: product("bangla", { name: BANGLA_TITLE, imageUrl: "", freeDelivery: true }),
  allFacts: product("facts", {
    discountedPrice: 1000,
    freeDelivery: true,
    brand: { name: "Walton" },
    keySpecs: ["Intel Core i5-1335U", "8GB DDR4, 512GB SSD", "15.6\" FHD IPS", "Backlit keyboard", "Fingerprint reader"],
    rating: { average: 4.64, count: 128 },
    soldCount: 129,
    packSize: "400 gm",
    emiMonthlyFrom: 2500,
  }),
  // Every fact at zero or blank: nothing may render (no fake zero states).
  zeroFacts: product("zero", {
    brand: { name: "  " },
    keySpecs: [" "],
    rating: { average: 0, count: 0 },
    soldCount: 9,
    packSize: "",
    emiMonthlyFrom: 0,
  }),
};
type Fixture = keyof typeof PRODUCTS;
const FIXTURES = Object.keys(PRODUCTS) as Fixture[];

function themeWith(card: string, tokens: Partial<StorefrontThemeDocument["tokens"]>): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  theme.blocks.card = storefrontBlockDefault("card", card) as never;
  theme.tokens = { ...theme.tokens, ...tokens };
  return storefrontThemeDocumentSchema.parse(theme);
}

async function renderCards(theme: StorefrontThemeDocument, props: object = {}): Promise<Record<Fixture, Element>> {
  const locals = { storefrontTheme: Promise.resolve(requestThemeFor(theme)) };
  const html = await Promise.all(
    FIXTURES.map((fixture, index) =>
      container.renderToString(ProductCard, {
        props: { product: PRODUCTS[fixture], currencySymbol: "৳", currencyCode: "BDT", index, aboveFold: true, ...props },
        locals,
        request: new Request("https://shop.test/"),
      })),
  );
  const cards = Array.from(parse(html.join("")).querySelectorAll('[data-theme-component="product-card"]'));
  expect(cards).toHaveLength(FIXTURES.length);
  return Object.fromEntries(FIXTURES.map((fixture, index) => [fixture, cards[index]!])) as Record<Fixture, Element>;
}

const CARD_VARIANTS = storefrontBlockVariants("card");
const MATRIX = CARD_VARIANTS.flatMap((card) =>
  STOREFRONT_DENSITIES.flatMap((density) =>
    STOREFRONT_IMAGE_RATIOS.flatMap((imageRatio) =>
      STOREFRONT_IMAGE_FITS.map((imageFit) => ({ card, density, imageRatio, imageFit })))));

const DISCOUNT_WORDING: Record<StorefrontCardRenderer["discount"], string> = {
  percent: "-20%",
  sale: "Sale",
  save: "Save ৳240",
  off: "৳240 OFF",
};

// ─── The matrix ───────────────────────────────────────────────────────────

describe("product card matrix", () => {
  it("covers every card variant with every density, image ratio and fit", () => {
    expect(MATRIX).toHaveLength(CARD_VARIANTS.length * STOREFRONT_DENSITIES.length * STOREFRONT_IMAGE_RATIOS.length * STOREFRONT_IMAGE_FITS.length);
    expect(CARD_VARIANTS).toEqual(["standard", "boutique", "portrait", "fashion-value", "spec", "tech-rounded", "retail", "marketplace", "quick-add"]);
  });

  it.each(MATRIX)("$card / $density / $imageRatio / $imageFit", async ({ card, density, imageRatio, imageFit }) => {
    const theme = themeWith(card, { density, imageRatio, imageFit });
    const anatomy = requestThemeFor(theme).layout.productCard;
    const cards = await renderCards(theme);
    const { width, height } = CARD_IMAGE_DIMENSIONS[imageRatio];

    for (const fixture of FIXTURES) {
      const element = cards[fixture];
      expect(element.getAttribute("data-card-variant")).toBe(card);
      expect(element.getAttribute("data-card-ratio")).toBe(imageRatio);
      // The photo box is always there; its ratio is the token (CSS), so a
      // missing photo keeps the same box: the placeholder, never a gap.
      const media = element.querySelector(":scope > .product-card-media")!;
      expect(media).not.toBeNull();
      const photo = media.querySelector(":scope > img.product-card-photo");
      const placeholder = media.querySelector("[data-card-placeholder]");
      const hasPhoto = Boolean(PRODUCTS[fixture].imageUrl);
      expect(Boolean(photo)).toBe(hasPhoto);
      expect(Boolean(placeholder)).toBe(!hasPhoto);
      if (photo) {
        expect(photo.getAttribute("width")).toBe(String(width));
        expect(photo.getAttribute("height")).toBe(String(height));
        expect(photo.getAttribute("alt")).toBe(PRODUCTS[fixture].name);
      } else {
        expect(placeholder!.getAttribute("aria-hidden")).toBe("true");
        expect(media.querySelector(".product-card-hover-image")).toBeNull();
      }
      // One stretched title link to the product plus at most the buy action.
      const links = Array.from(element.querySelectorAll("a"));
      expect(links.filter((link) => link.classList.contains("product-card-link")).map((link) => link.getAttribute("href")))
        .toEqual([`/products/${PRODUCTS[fixture].slug}`]);
      expect(links.length).toBeLessThanOrEqual(2);
      // Titles are clamped; the anatomy's titles also break long words.
      const title = element.querySelector(".product-card-link")!.parentElement!;
      expect(title.className).toMatch(/\bline-clamp-[12]\b/);
      if (card !== "standard") expect(title.classList.contains("product-card-name")).toBe(true);
    }

    // No fake zero states: blank or zero facts render nothing.
    expect(cards.zeroFacts.querySelector("[data-card-fact]")).toBeNull();
    expect(text(cards.zeroFacts)).not.toMatch(/\b\d+ sold\b|\(0\)|★|EMI/);

    // Hover photo only where the card shows one, and only with a primary photo.
    expect(Boolean(cards.onSale.querySelector(".product-card-hover-image"))).toBe(anatomy.hoverImage);
    expect(cards.noPhoto.querySelector(".product-card-hover-image")).toBeNull();

    // The discount, worded and placed by the anatomy.
    const imageDiscount = cards.onSale.querySelector(".product-card-media [data-card-discount]");
    const priceDiscount = cards.onSale.querySelector(".product-card-price-row [data-card-discount]");
    const wording = card === "standard" ? "-20%" : DISCOUNT_WORDING[anatomy.discount];
    expect(text(anatomy.badge === "image" ? imageDiscount : priceDiscount)).toBe(wording);
    expect(anatomy.badge === "image" ? priceDiscount : imageDiscount).toBeNull();
    // Amount wordings fall back to the percentage when the price varies by option.
    expect(text(cards.soldOut)).toContain("Sold out");

    if (card === "standard") return;

    // Facts: every fact in the anatomy that has data, in the anatomy's order.
    const expectedFacts = anatomy.body.filter((part) => part !== "title" && part !== "price");
    expect(Array.from(cards.allFacts.querySelectorAll("[data-card-fact]")).map((node) => node.getAttribute("data-card-fact")))
      .toEqual(expectedFacts);
    const fact = (name: string) => text(cards.allFacts.querySelector(`[data-card-fact="${name}"]`));
    if (expectedFacts.includes("key-specs")) {
      expect(cards.allFacts.querySelectorAll('[data-card-fact="key-specs"] li')).toHaveLength(KEY_SPECS_MAX);
    }
    if (expectedFacts.includes("rating")) expect(fact("rating")).toContain("4.6");
    if (expectedFacts.includes("sold")) expect(fact("sold")).toBe("129 sold");
    if (expectedFacts.includes("savings")) expect(fact("savings")).toBe("Save ৳200");
    if (expectedFacts.includes("emi")) expect(fact("emi")).toBe("EMI from ৳2,500/month");
    if (expectedFacts.includes("delivery")) expect(fact("delivery")).toBe("Free delivery");
    if (expectedFacts.includes("brand")) expect(fact("brand")).toBe("Walton");
    if (expectedFacts.includes("pack-size")) expect(fact("pack-size")).toBe("400 gm");
    // The body order: price before or after the title as measured.
    const body = cards.allFacts.querySelector(".product-card-body")!;
    const order = Array.from(body.children).map((child) =>
      child.querySelector(".product-card-link") ? "title"
        : child.classList.contains("product-card-price-row") ? "price"
          : child.getAttribute("data-card-fact"));
    expect(order.filter((part) => part !== null)).toEqual(anatomy.body);

    // The buy action: in stock without options only, above the card link,
    // named with its visible words first (WCAG 2.5.3).
    const action = (element: Element) => element.querySelector('a[href^="/buy/"]');
    const label = anatomy.actionLabel === "buy-now" ? "Buy now" : "Add to cart";
    for (const fixture of ["onSale", "noPhoto", "allFacts"] as const) {
      expect(Boolean(action(cards[fixture])), fixture).toBe(anatomy.quickBuy);
    }
    expect(action(cards.withOptions)).toBeNull();
    expect(action(cards.soldOut)).toBeNull();
    if (anatomy.quickBuy) {
      const buy = action(cards.onSale)!;
      expect(buy.getAttribute("href")).toBe("/buy/product-sale");
      expect(buy.getAttribute("rel")).toBe("nofollow");
      expect(buy.className).toMatch(/\bz-10\b/);
      expect(buy.hasAttribute("aria-label")).toBe(false);
      expect(text(buy)).toBe(`${label}: Product sale`);
      if (anatomy.action === "round") {
        expect(buy.classList.contains("product-card-round-action")).toBe(true);
        expect(buy.parentElement!.classList.contains("product-card-media")).toBe(true);
      } else {
        expect(buy.classList.contains("product-card-action")).toBe(true);
        // Options are chosen on the product page (a hint under the card
        // link, not a second tab stop); sold out keeps the action's space.
        const hint = cards.withOptions.querySelector("[data-card-action-hint]")!;
        expect(hint.getAttribute("aria-hidden")).toBe("true");
        expect(hint.className).toContain("pointer-events-none");
        expect(cards.soldOut.querySelector("[data-quick-buy-spacer]")!.classList.contains("product-card-action")).toBe(true);
      }
    } else {
      expect(cards.withOptions.querySelector("[data-card-action-hint], [data-quick-buy-spacer]")).toBeNull();
    }

    // The price tone is a colour role: the action colour, the sale colour
    // while discounted, or ink.
    const priceClass = cards.onSale.querySelector(".product-card-price")!.classList;
    const tone = anatomy.priceTone === "primary" ? "text-primary" : anatomy.priceTone === "sale" ? "text-destructive" : "text-foreground";
    expect(priceClass.contains(tone)).toBe(true);
    expect(cards.withOptions.querySelector(".product-card-price")!.textContent).toContain("From ৳1,200");
  });

  it("keeps the standard card's markup (the protected Department mall look)", async () => {
    const cards = await renderCards(DEFAULT_STOREFRONT_THEME);
    const card = cards.onSale;
    expect(card.className).toBe("group relative flex flex-col h-full bg-card overflow-hidden");
    expect(card.querySelector(".product-card-media")!.className).toBe("product-card-media relative overflow-hidden bg-muted");
    expect(card.querySelector(".product-card-photo")!.className).toBe("product-card-photo w-full h-full object-center");
    expect(card.querySelector(".product-card-body")!.className).toBe("product-card-body p-3 sm:p-4 flex flex-col flex-1");
    expect(card.querySelector(".product-card-link")!.parentElement!.className).toBe(
      "mb-1.5 text-sm sm:text-[0.9375rem] font-medium text-foreground leading-snug line-clamp-2 min-h-[2.5em] [font-family:var(--theme-font-body)] [letter-spacing:0]",
    );
    expect(text(card.querySelector("p"))).toBe("Regular price ৳1,200Sale price ৳960");
    expect(card.querySelector("a[href^='/buy/']")).toBeNull();
  });

  it("uses the store's rows on phones when the listing asks for list rows", async () => {
    const theme = themeWith("retail", { density: "comfortable" });
    const locals = { storefrontTheme: Promise.resolve(requestThemeFor(theme)) };
    const html = await container.renderToString(ProductGrid, {
      props: { phoneLayout: "list-row" },
      locals,
      request: new Request("https://shop.test/"),
    });
    expect(parse(html).querySelector(".product-grid")!.getAttribute("data-phone-layout")).toBe("list-row");
    const cards = await renderCards(theme, { phoneLayout: "list-row" });
    // Below the tablet step the photo is the fixed list-row column.
    expect(cards.onSale.querySelector("img")!.getAttribute("sizes")).toMatch(/^\(max-width: \d+px\) 120px, /);
    const grid = parse(await container.renderToString(ProductGrid, { props: {}, locals, request: new Request("https://shop.test/") }));
    expect(grid.querySelector(".product-grid")!.hasAttribute("data-phone-layout")).toBe(false);
  });

  it("gives a product without a photo its initial, Bangla included", async () => {
    const cards = await renderCards(themeWith("marketplace", {}));
    expect(text(cards.noPhoto.querySelector("[data-card-placeholder]"))).toBe("P");
    expect(text(cards.bangla.querySelector("[data-card-placeholder]"))).toBe(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(BANGLA_TITLE))[0]!.segment);
    expect(text(cards.bangla.querySelector(".product-card-link"))).toBe(BANGLA_TITLE);
  });
});
