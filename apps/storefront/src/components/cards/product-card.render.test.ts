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
    cardFacts: {
      brand: { name: "Walton", slug: "walton" },
      keySpecs: ["Processor: Intel Core i5-1335U", "RAM: 8GB DDR4", "Display: 15.6\" FHD IPS", "Keyboard: Backlit", "Security: Fingerprint reader"],
      options: [
        // "Midnight" is no CSS colour and has no swatch colour: it is left out, never guessed.
        { name: "Colour", kind: "color", count: 3, swatches: [{ label: "Navy", hex: "#1f2a44" }, { label: "Light Blue", hex: null }, { label: "Midnight", hex: null }] },
        { name: "Size", kind: "size", count: 5, swatches: [] },
      ],
      soldLast30Days: 129,
      packSize: "400 gm",
      delivery: { free: false, feeFrom: 60 },
    },
    rating: { average: 4.64, count: 128 },
    emiMonthlyFrom: 2500,
  }),
  // Every fact at zero or blank: nothing may render (no fake zero states).
  zeroFacts: product("zero", {
    cardFacts: {
      brand: { name: "  ", slug: "blank" },
      keySpecs: [" "],
      options: [{ name: "Size", kind: "size", count: 1, swatches: [] }],
      soldLast30Days: 9,
      packSize: "",
      delivery: null,
    },
    rating: { average: 0, count: 0 },
    emiMonthlyFrom: 0,
  }),
  // One of our own uploads without renditions: never on a card.
  original: product("original", { imageUrl: "https://cdn.shop.test/media/media_original.jpg" }),
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

/**
 * The buyer-visible treatments of one rendered card (the structural half of
 * the fidelity bar; the harness measures the same traits in a browser): the
 * photo box, the tile, the price's place, size and colour, the struck
 * price, the discount mark, the rating, the facts, the title, the button and
 * Compare.
 */
function cardTraits(card: Element, anatomy: ReturnType<typeof requestThemeFor>["layout"]["productCard"]): Record<string, string> {
  const style = card.getAttribute("style") ?? "";
  const cssVar = (name: string) => new RegExp(`--${name}:([^;]+)`).exec(style)?.[1] ?? "theme";
  const body = card.querySelector(".product-card-body")!;
  const order = Array.from(body.children).map((child) =>
    child.querySelector(".product-card-link") ? "title" : child.querySelector("s, .pc-price-reg, .product-card-price") || child.matches("p.mt-auto") ? "price" : null)
    .filter(Boolean);
  const price = card.querySelector(".product-card-price") ?? body.querySelector("p.mt-auto > span:last-child")!;
  const regular = card.querySelector(".pc-price-regular, s")!;
  const strikeAt = regular.compareDocumentPosition(price) & 4 ? "before" : "after";
  const marks = Array.from(card.querySelectorAll("[data-card-discount]")).map((mark) =>
    `${mark.closest(".product-card-media") ? "photo" : "price"}:${text(mark)}:${Array.from(mark.classList).filter((name) => /^pc-(badge|discount)-/.test(name)).join("+")}`);
  const rating = card.querySelector('[data-card-fact="rating"]');
  const action = card.querySelector("a[href^='/buy/']");
  return {
    // The standard card follows the template's tokens (department-mall: a
    // square cover photo, 15/500 titles, an 18px price), in the same units.
    ratio: String(anatomy.look.image.ratio),
    fit: `${anatomy.look.image.fit}/${cssVar("pc-inset") === "theme" ? "0%" : cssVar("pc-inset")}`,
    surface: `${anatomy.look.surface}/${anatomy.look.radius}`,
    pricePlace: order.indexOf("price") < order.indexOf("title") ? "before-title" : "after-title",
    priceSize: String(anatomy.look.price?.size.desktop ?? 18),
    priceColour: price.classList.contains("pc-price-super") ? "superscript" : ["text-primary", "text-destructive", "text-foreground"].find((name) => price.classList.contains(name)) ?? "?",
    strike: `${strikeAt}:${text(regular).replace(/[\d৳,.\s]/g, "").replace("Regularprice", "")}${regular.querySelector("s") || regular.tagName === "S" ? ":struck" : ""}`,
    discount: marks.sort().join("|"),
    rating: rating ? (rating.classList.contains("pc-rating-stars") ? "stars" : "score") : "none",
    facts: Array.from(card.querySelectorAll("[data-card-fact]")).map((node) => node.getAttribute("data-card-fact")).sort().join(","),
    title: `${card.querySelector(".product-card-link")!.parentElement!.className.match(/line-clamp-\d/)![0]}/${anatomy.look.title?.weight ?? 500}/${anatomy.look.title?.size.desktop ?? 15}`,
    button: action ? `${anatomy.action}:${text(action).split(":")[0]}` : "none",
    compare: card.querySelector("[data-compare-toggle]") ? "compare" : "none",
  };
}

// ─── The matrix ───────────────────────────────────────────────────────────

describe("product card matrix", () => {
  it("covers every card variant with every density, image ratio and fit", () => {
    expect(MATRIX).toHaveLength(CARD_VARIANTS.length * STOREFRONT_DENSITIES.length * STOREFRONT_IMAGE_RATIOS.length * STOREFRONT_IMAGE_FITS.length);
    expect(CARD_VARIANTS).toEqual(["standard", "boutique", "portrait", "fashion-value", "spec", "tech-rounded", "retail", "marketplace", "quick-add", "detailed"]);
  });

  it.each(MATRIX)("$card / $density / $imageRatio / $imageFit", async ({ card, density, imageRatio, imageFit }) => {
    const theme = themeWith(card, { density, imageRatio, imageFit });
    const anatomy = requestThemeFor(theme).layout.productCard;
    const cards = await renderCards(theme);
    // The standard card follows the theme's ratio token; every other card its own look.
    const ownRatio = card === "standard" ? imageRatio : anatomy.imageRatio;
    const { width, height } = card === "standard"
      ? CARD_IMAGE_DIMENSIONS[imageRatio]
      : { width: 400, height: Math.round(400 / anatomy.look.image.ratio) };

    for (const fixture of FIXTURES) {
      const element = cards[fixture];
      expect(element.getAttribute("data-card-variant")).toBe(card);
      expect(element.getAttribute("data-card-ratio")).toBe(ownRatio);
      // The photo box is always there; its ratio is the token (CSS), so a
      // missing photo keeps the same box: the placeholder, never a gap.
      const media = element.querySelector(":scope > .product-card-media")!;
      expect(media).not.toBeNull();
      const photo = media.querySelector(":scope > img.product-card-photo");
      const placeholder = media.querySelector("[data-card-placeholder]");
      const hasPhoto = Boolean(PRODUCTS[fixture].imageUrl) && fixture !== "original";
      expect(Boolean(photo)).toBe(hasPhoto);
      expect(Boolean(placeholder)).toBe(!hasPhoto);
      if (photo) {
        expect(photo.getAttribute("width")).toBe(String(width));
        expect(photo.getAttribute("height")).toBe(String(height));
        expect(photo.getAttribute("alt")).toBe(PRODUCTS[fixture].name);
      } else {
        expect(placeholder!.getAttribute("aria-hidden")).toBe("true");
        expect(media.hasAttribute("data-hover-src")).toBe(false);
      }
      // No hover photo is in the HTML: the box names it for the intent script.
      expect(media.querySelector(".product-card-hover-image")).toBeNull();
      // One stretched title link to the product plus at most the buy action (and Compare).
      const links = Array.from(element.querySelectorAll("a"));
      expect(links.filter((link) => link.classList.contains("product-card-link")).map((link) => link.getAttribute("href")))
        .toEqual([`/products/${PRODUCTS[fixture].slug}`]);
      expect(links.length).toBeLessThanOrEqual(anatomy.compare ? 3 : 2);
      // Titles are clamped; the anatomy's titles also break long words.
      const title = element.querySelector(".product-card-link")!.parentElement!;
      expect(title.className).toMatch(/\bline-clamp-[123]\b/);
      if (card !== "standard") expect(title.classList.contains("product-card-name")).toBe(true);
    }

    // No fake zero states: blank or zero facts render nothing.
    expect(cards.zeroFacts.querySelector("[data-card-fact]")).toBeNull();
    expect(text(cards.zeroFacts)).not.toMatch(/\b\d+ sold\b|\(0\)|★|EMI|Options|bought/);

    // Hover photo only where the card shows one, and only with a primary photo.
    const hoverBox = (element: Element) => element.querySelector(".product-card-media")!.getAttribute("data-hover-src");
    expect(Boolean(hoverBox(cards.onSale))).toBe(anatomy.hoverImage);
    if (anatomy.hoverImage) expect(hoverBox(cards.onSale)).toBe(image("sale-back"));
    expect(hoverBox(cards.noPhoto)).toBeNull();

    // The discount, worded and placed by the anatomy ("both": the wording on
    // the photo and the percentage again after the struck price).
    const imageDiscount = cards.onSale.querySelector(".product-card-media [data-card-discount]");
    const priceDiscount = cards.onSale.querySelector(".product-card-price-row [data-card-discount]");
    const wording = card === "standard" ? "-20%" : DISCOUNT_WORDING[anatomy.discount];
    if (anatomy.badge === "both") {
      expect(text(imageDiscount)).toBe(wording);
      expect(text(priceDiscount)).toBe("-20%");
    } else {
      expect(text(anatomy.badge === "image" ? imageDiscount : priceDiscount)).toBe(wording);
      expect(anatomy.badge === "image" ? priceDiscount : imageDiscount).toBeNull();
    }
    // No discount, no mark and no struck price anywhere.
    expect(cards.withOptions.querySelector("[data-card-discount], s, .pc-price-reg")).toBeNull();
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
      expect(text(cards.allFacts.querySelector('[data-card-fact="key-specs"] li'))).toBe("Processor: Intel Core i5-1335U");
    }
    if (expectedFacts.includes("rating")) expect(fact("rating")).toContain("4.6");
    if (expectedFacts.includes("sold")) {
      expect(fact("sold")).toBe(card === "detailed" ? "100+ bought in past month" : "129 sold in 30 days");
    }
    if (expectedFacts.includes("swatches")) {
      // A swatch colour from the swatch attribute, or an exact CSS colour name; never a guess.
      const swatches = Array.from(cards.allFacts.querySelectorAll(".pc-swatch"));
      expect(swatches.map((swatch) => swatch.getAttribute("style"))).toEqual(["--swatch:#1f2a44", "--swatch:lightblue"]);
    }
    if (expectedFacts.includes("options")) expect(fact("options")).toBe("Options: 5 sizes");
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
        // Chaldal's "+" sits on the photo; Fabrilife's cart beside the price.
        const home = card === "fashion-value" ? "product-card-body" : "product-card-media";
        expect(buy.parentElement!.classList.contains(home)).toBe(true);
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
    const tone = anatomy.priceTone === "primary" ? "text-primary"
      : anatomy.priceTone === "sale" || anatomy.priceTone === "sale-always" ? "text-destructive" : "text-foreground";
    expect(priceClass.contains(tone)).toBe(true);
    // Without a discount the sale colour stays for Star Tech's always-red price only.
    const plainTone = cards.withOptions.querySelector(".product-card-price")!.classList;
    expect(plainTone.contains("text-destructive")).toBe(anatomy.priceTone === "sale-always");
    // The struck price as the reference words it.
    const regular = cards.onSale.querySelector(".pc-price-regular")!;
    expect(text(regular)).toContain("৳1,200");
    expect(Boolean(regular.querySelector("s"))).toBe(anatomy.strike !== "reg");
    if (anatomy.strike === "list") expect(text(regular)).toMatch(/^List:/);
    if (anatomy.strike === "reg") expect(text(regular)).toMatch(/^reg /);
    const current = cards.onSale.querySelector(".product-card-price")!;
    const before = Boolean(regular.compareDocumentPosition(current) & 4);
    expect(before).toBe(anatomy.strike === "before");
    expect(cards.withOptions.querySelector(".product-card-price")!.textContent).toContain("From ৳1,200");

    // Compare (Star Tech): a plain link to the comparison without JavaScript.
    const compare = cards.onSale.querySelector("[data-compare-toggle]");
    expect(Boolean(compare)).toBe(anatomy.compare);
    if (compare) expect(compare.getAttribute("href")).toBe("/compare?ids=sale");
  });

  it("makes every two cards differ in at least three buyer-visible treatments on a product with every fact", async () => {
    const all: Record<string, Record<string, string>> = {};
    for (const card of CARD_VARIANTS) {
      const theme = themeWith(card, {});
      all[card] = cardTraits((await renderCards(theme)).allFacts, requestThemeFor(theme).layout.productCard);
    }
    const short: string[] = [];
    for (let i = 0; i < CARD_VARIANTS.length; i += 1) {
      for (let j = i + 1; j < CARD_VARIANTS.length; j += 1) {
        const [a, b] = [CARD_VARIANTS[i]!, CARD_VARIANTS[j]!];
        const differing = Object.keys(all[a]!).filter((trait) => all[a]![trait] !== all[b]![trait]);
        if (differing.length < 3) short.push(`${a}~${b}: ${differing.join(", ") || "nothing"}`);
      }
    }
    expect(short).toEqual([]);
  });

  it("draws Amazon's superscript price and the delivery line from the stored rate", async () => {
    const cards = await renderCards(themeWith("detailed", {}));
    const price = cards.onSale.querySelector(".pc-price-super")!;
    expect(text(price.querySelector(".pc-price-symbol"))).toBe("৳");
    expect(text(price.querySelector(".pc-price-whole"))).toBe("960");
    expect(text(cards.onSale.querySelector(".pc-price-regular"))).toContain("৳1,200");
    expect(text(cards.bangla.querySelector('[data-card-fact="delivery"]'))).toBe("Free delivery");
    const fee = await renderCards(themeWith("detailed", {}));
    expect(text(fee.allFacts.querySelector('[data-card-fact="delivery"]'))).toBe("Free delivery");
    const retail = await container.renderToString(ProductCard, {
      props: {
        product: { ...PRODUCTS.allFacts, freeDelivery: false },
        currencySymbol: "৳",
        currencyCode: "BDT",
      },
      locals: { storefrontTheme: Promise.resolve(requestThemeFor(themeWith("retail", {}))) },
      request: new Request("https://shop.test/"),
    });
    expect(text(parse(retail).querySelector('[data-card-fact="delivery"]'))).toBe("Delivery from ৳60");
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
    // (retail: the phone-density cap is listed first, then the plain entries).
    expect(cards.onSale.querySelector("img")!.getAttribute("sizes")).toMatch(/(?:^|, )\(max-width: \d+px\) calc\(\(120px\) \* 1\)|(?:^|, )\(max-width: \d+px\) 120px, /);
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
