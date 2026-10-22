// @vitest-environment node
/**
 * The one product card, render-only: every facts x action setting renders
 * the real ProductCard (Astro container API through a Vite dev server in
 * middleware mode) for products that exercise each part: on sale, with
 * options, sold out, without a photo, a long Bangla title, every optional
 * fact, and facts at zero. Layout on real viewports needs a browser; this
 * checks the markup the card promises: which parts exist and when, one
 * discount mark, the words a screen reader hears, both languages, heading
 * levels and the structure that keeps cards in a row equally tall.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  STOREFRONT_CARD_ACTIONS,
  STOREFRONT_CARD_FACTS,
  STOREFRONT_DENSITIES,
  STOREFRONT_IMAGE_FITS,
  STOREFRONT_IMAGE_RATIOS,
  STOREFRONT_THEME_SURFACES,
  buildStorefrontThemeTokens,
  storefrontBlockVariants,
  storefrontTemplateTheme,
  storefrontThemeDocumentSchema,
  type StorefrontCardAction,
  type StorefrontCardFacts,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { requestThemeFor } from "@/lib/storefront-theme-context";
import { productCardImageSizes, productGridSpec } from "@/lib/product-card-layout";
import { capPhoneSizesDensity, scaleSizes } from "@/lib/responsive-image";
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
    priceVaries: false,
    quickAddEligible: true,
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

type CardSettings = { facts?: StorefrontCardFacts; action?: StorefrontCardAction; hoverImage?: boolean };

/** The department mall preset with these card settings and token overrides. */
function themeWith(card: CardSettings, tokens: Partial<StorefrontThemeDocument["tokens"]> = {}): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  theme.blocks.card = {
    variant: "standard",
    settings: { facts: "none", action: "none", hoverImage: false, ...card },
  } as never;
  theme.tokens = { ...theme.tokens, ...tokens };
  return storefrontThemeDocumentSchema.parse(theme);
}

/** A store that takes reviews and has a published one (cards may show ratings). */
const REVIEWED_STORE = { ...EMPTY_STORE_SHAPE, hasReviews: true };

async function renderCards(
  theme: StorefrontThemeDocument,
  props: object = {},
  shape = REVIEWED_STORE,
  languageCode?: string,
): Promise<Record<Fixture, Element>> {
  const locals = { storefrontTheme: Promise.resolve(requestThemeFor(theme, shape, { languageCode })) };
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

async function renderOne(theme: StorefrontThemeDocument, productOverrides: object, props: object = {}, shape = REVIEWED_STORE, languageCode?: string) {
  const locals = { storefrontTheme: Promise.resolve(requestThemeFor(theme, shape, { languageCode })) };
  const html = await container.renderToString(ProductCard, {
    props: { product: { ...PRODUCTS.onSale, ...productOverrides }, currencySymbol: "৳", currencyCode: "BDT", ...props },
    locals,
    request: new Request("https://shop.test/"),
  });
  return parse(html).querySelector('[data-theme-component="product-card"]')!;
}

const fact = (card: Element, name: string) => card.querySelector(`[data-card-fact="${name}"]`);
const factNames = (card: Element) => Array.from(card.querySelectorAll("[data-card-fact]")).map((node) => node.getAttribute("data-card-fact"));
/** The decorative action hint (the title link covers the card). */
const hint = (card: Element) => card.querySelector("[data-card-action-hint]");
const quickAdd = (card: Element) => card.querySelector("a[data-card-quick-add]");

const COMBINATIONS = STOREFRONT_CARD_FACTS.flatMap((facts) => STOREFRONT_CARD_ACTIONS.map((action) => ({ facts, action })));

describe("the one product card", () => {
  it("is the only card variant", () => {
    expect(storefrontBlockVariants("card")).toEqual(["standard"]);
    expect(COMBINATIONS).toHaveLength(12);
  });

  it.each(COMBINATIONS)("facts $facts / action $action: renders each part only when its data exists", async ({ facts, action }) => {
    const cards = await renderCards(themeWith({ facts, action }));

    for (const fixture of FIXTURES) {
      const card = cards[fixture];
      const at = `${facts}/${action}/${fixture}`;
      // One card, one design: no per-site variant attribute, the settings are the only switches.
      expect(card.hasAttribute("data-card-variant"), at).toBe(false);
      expect(card.getAttribute("data-action"), at).toBe(action);
      expect(card.classList.contains("product-card"), at).toBe(true);
      // The title is the card's one link, and it is a heading.
      const links = Array.from(card.querySelectorAll("a")).filter((link) => link.classList.contains("product-card-link"));
      expect(links.map((link) => link.getAttribute("href")), at).toEqual([`/products/${PRODUCTS[fixture].slug}`]);
      expect(card.querySelector(".product-card-name")!.tagName, at).toBe("H3");
      expect(card.querySelector(".product-card-name > a.product-card-link"), at).not.toBeNull();
      // Equal heights: the price (and the action) sit in the foot, the body's last child.
      const body = card.querySelector(".product-card-body")!;
      const foot = body.lastElementChild!;
      expect(foot.classList.contains("product-card-foot"), at).toBe(true);
      expect(foot.querySelector(".sf-price"), at).not.toBeNull();
      expect(card.querySelectorAll(".product-card-foot"), at).toHaveLength(1);
      // No fake zero states, whatever the settings.
      expect(text(card), at).not.toMatch(/\(0\)|\b0 reviews\b|EMI|\b\d+ sold\b|bought/i);
    }

    // The facts setting picks one fact; the others never render. Pack size
    // and condition are details under every setting.
    const all = cards.allFacts;
    expect(fact(all, "key-specs") !== null).toBe(facts === "key-specs");
    expect(fact(all, "swatches") !== null).toBe(facts === "swatches");
    expect(fact(all, "delivery") !== null).toBe(facts === "delivery");
    expect(text(fact(all, "details"))).toBe("400 gm");
    if (facts === "key-specs") {
      const specs = Array.from(fact(all, "key-specs")!.querySelectorAll("li")).map((item) => text(item));
      expect(specs).toEqual(["Processor: Intel Core i5-1335U", "RAM: 8GB DDR4", "Display: 15.6\" FHD IPS"]);
      expect(specs).toHaveLength(KEY_SPECS_MAX);
    }
    if (facts === "swatches") {
      // "Midnight" has no known colour and is left out; the third colour counts in "+1".
      const swatches = fact(all, "swatches")!;
      expect(swatches.querySelectorAll(".product-card-swatch")).toHaveLength(2);
      expect(text(swatches.querySelector(".product-card-swatch-more"))).toBe("+1");
      expect(text(swatches.querySelector(".sr-only"))).toBe("Colours: Navy, Light Blue, 1 more colour");
      expect(swatches.querySelector(".product-card-swatch")!.getAttribute("aria-hidden")).toBe("true");
    }
    if (facts === "delivery") expect(text(fact(all, "delivery"))).toBe("Free delivery");

    // Facts with no data render nothing, even when selected.
    for (const fixture of ["zeroFacts", "withOptions", "onSale", "soldOut", "noPhoto"] as const) {
      expect(fact(cards[fixture], "key-specs"), fixture).toBeNull();
      expect(fact(cards[fixture], "swatches"), fixture).toBeNull();
      expect(fact(cards[fixture], "details"), fixture).toBeNull();
      expect(fact(cards[fixture], "delivery"), fixture).toBeNull();
    }
    expect(factNames(cards.zeroFacts)).toEqual([]);
    // The Bangla fixture ships free: only the delivery setting shows it.
    expect(fact(cards.bangla, "delivery") !== null).toBe(facts === "delivery");

    // The action: none leaves the card one link; quick-add is a round control
    // on the photo; full is a button in the foot.
    const quick = (card: Element) => card.querySelector(".product-card-media .product-card-quick");
    const full = (card: Element) => card.querySelector(".product-card-foot .product-card-action");
    if (action === "none") {
      for (const fixture of FIXTURES) {
        expect(cards[fixture].querySelector(".product-card-quick, .product-card-action, [data-card-quick-add], [data-card-action-hint]"), fixture).toBeNull();
        expect(cards[fixture].querySelectorAll("a"), fixture).toHaveLength(1);
      }
    }
    if (action === "quick-add") {
      for (const fixture of ["onSale", "noPhoto", "bangla", "allFacts", "zeroFacts"] as const) {
        const add = quick(cards[fixture])!;
        expect(add.tagName, fixture).toBe("A");
        expect(add.getAttribute("href"), fixture).toBe(`/products/${PRODUCTS[fixture].slug}`);
        expect(add.hasAttribute("data-card-quick-add"), fixture).toBe(true);
        expect(add.getAttribute("rel"), fixture).toBe("nofollow");
        // The name a screen reader hears says what it adds.
        expect(text(add), fixture).toBe(`Add to cart: ${PRODUCTS[fixture].name}`);
        expect(add.querySelector("svg")!.getAttribute("aria-hidden"), fixture).toBe("true");
        expect(hint(cards[fixture]), fixture).toBeNull();
      }
      // Options are chosen on the product page: a decorative hint under the card link.
      const choose = hint(cards.withOptions)!;
      expect(choose.tagName).toBe("SPAN");
      expect(choose.getAttribute("aria-hidden")).toBe("true");
      expect(choose.classList.contains("product-card-quick")).toBe(true);
      expect(quickAdd(cards.withOptions)).toBeNull();
      // Sold out: nothing to add and no hint.
      expect(card_has_no_action(cards.soldOut)).toBe(true);
      expect(full(cards.onSale)).toBeNull();
    }
    if (action === "full") {
      for (const fixture of ["onSale", "noPhoto", "bangla", "allFacts", "zeroFacts"] as const) {
        const add = full(cards[fixture])!;
        expect(add.tagName, fixture).toBe("A");
        expect(add.classList.contains("sf-button"), fixture).toBe(true);
        expect(add.getAttribute("href"), fixture).toBe(`/products/${PRODUCTS[fixture].slug}`);
        expect(add.hasAttribute("data-card-quick-add"), fixture).toBe(true);
        expect(text(add), fixture).toBe(`Add to cart: ${PRODUCTS[fixture].name}`);
        expect(add.querySelector(".sr-only")!.textContent, fixture).toBe(`: ${PRODUCTS[fixture].name}`);
        expect(hint(cards[fixture]), fixture).toBeNull();
      }
      // Options and sold out: the full action is a decorative span (the title link is the control).
      const options = hint(cards.withOptions)!;
      expect(options.tagName).toBe("SPAN");
      expect(options.getAttribute("aria-hidden")).toBe("true");
      expect(options.classList.contains("sf-button")).toBe(true);
      expect(text(options)).toBe("Choose options");
      expect(options.closest(".product-card-foot")).not.toBeNull();
      expect(quickAdd(cards.withOptions)).toBeNull();
      const sold = hint(cards.soldOut)!;
      expect(sold.getAttribute("aria-hidden")).toBe("true");
      expect(text(sold)).toBe("View product");
      expect(quickAdd(cards.soldOut)).toBeNull();
      // Never two actions on one card.
      for (const fixture of FIXTURES) expect(cards[fixture].querySelectorAll(".product-card-foot .product-card-action"), fixture).toHaveLength(1);
      expect(cards.onSale.querySelector(".product-card-media .product-card-quick")).toBeNull();
    }
  });

  it("sends a simple product that cannot be added from a card to its page, not to the cart", async () => {
    for (const blocked of [
      { quickAddEligible: false },
      { quickAddEligible: undefined },
      { priceVaries: true },
      { requiresCustomization: true },
      { customizationUnavailable: true },
      { discountedPrice: 0 },
      { isGiftCard: true },
    ]) {
      const label = JSON.stringify(blocked);
      const full = await renderOne(themeWith({ action: "full" }), blocked);
      expect(quickAdd(full), label).toBeNull();
      expect(full.querySelector("a.product-card-action"), label).toBeNull();
      expect(text(hint(full)), label).toBe("View product");
      expect(hint(full)!.getAttribute("aria-hidden"), label).toBe("true");
      const quick = await renderOne(themeWith({ action: "quick-add" }), blocked);
      expect(card_has_no_action(quick), label).toBe(true);
    }
    // A product with options asks for a choice.
    const options = await renderOne(themeWith({ action: "full" }), { hasVariants: true, quickAddEligible: false });
    expect(text(hint(options))).toBe("Choose options");
    // Sold out wins over options.
    const soldOptions = await renderOne(themeWith({ action: "full" }), { hasVariants: true, availableForSale: false });
    expect(text(hint(soldOptions))).toBe("View product");
    expect(card_has_no_action(await renderOne(themeWith({ action: "quick-add" }), { hasVariants: true, availableForSale: false }))).toBe(true);
  });

  describe("the discount", () => {
    it.each(COMBINATIONS)("facts $facts / action $action: is one badge on the photo and nothing else says '-20%'", async ({ facts, action }) => {
      const { onSale, withOptions } = await renderCards(themeWith({ facts, action }));
      const badges = onSale.querySelectorAll(".sf-badge");
      expect(badges).toHaveLength(1);
      expect(badges[0]!.getAttribute("data-kind")).toBe("sale");
      expect(text(badges[0])).toBe("-20%");
      expect(badges[0]!.closest(".product-card-media")).not.toBeNull();
      expect(badges[0]!.parentElement!.classList.contains("product-card-badges")).toBe(true);
      // The only "-20%" in the card is the badge: the body never repeats it.
      expect(text(onSale).match(/-20%/g)).toHaveLength(1);
      expect(text(onSale.querySelector(".product-card-body"))).not.toMatch(/%|\bsave\b|\boff\b|-20/i);
      expect(onSale.querySelector(".sf-price-save")).toBeNull();
      // No discount, no mark.
      expect(withOptions.querySelector(".sf-badge, .product-card-badges")).toBeNull();
    });

    it("draws the sale price in the sale colour only when discounted, with the regular price struck after it", async () => {
      const { onSale, withOptions, bangla } = await renderCards(themeWith({}));
      const current = onSale.querySelector(".sf-price-current")!;
      expect(current.hasAttribute("data-sale")).toBe(true);
      expect(text(current)).toBe("Sale price ৳960");
      const compare = onSale.querySelector(".sf-price-compare")!;
      expect(text(compare)).toBe("Regular price ৳1,200");
      expect(compare.querySelector("s")!.textContent).toBe("৳1,200");
      // Sale first, the struck regular price after it.
      expect(current.compareDocumentPosition(compare) & 4).toBeTruthy();
      expect(onSale.querySelectorAll("s")).toHaveLength(1);
      // Undiscounted: the price in the text colour, no struck price.
      for (const card of [withOptions, bangla]) {
        expect(card.querySelector("[data-sale]")).toBeNull();
        expect(card.querySelector("s, .sf-price-compare")).toBeNull();
      }
      expect(text(bangla.querySelector(".sf-price-current"))).toBe("Price ৳1,200");
    });

    it("says 'From' when the price varies by option", async () => {
      const { withOptions } = await renderCards(themeWith({}));
      expect(text(withOptions.querySelector(".sf-price-current"))).toBe("Price From ৳1,200");
    });

    it("shows a sold-out badge instead of the sale badge on a discounted sold-out product", async () => {
      const card = await renderOne(themeWith({ action: "full" }), { availableForSale: false });
      const badges = card.querySelectorAll(".sf-badge");
      expect(badges).toHaveLength(1);
      expect(badges[0]!.getAttribute("data-kind")).toBe("sold-out");
      expect(text(badges[0])).toBe("Sold out");
      expect(text(card)).not.toContain("-20%");
    });
  });

  describe("the ratings", () => {
    it("shows the real score with its words for screen readers, once", async () => {
      const { allFacts } = await renderCards(themeWith({}));
      const rating = allFacts.querySelectorAll(".sf-rating");
      expect(rating).toHaveLength(1);
      expect(text(rating[0])).toContain("4.6");
      expect(text(rating[0])).toContain("(128)");
      expect(text(rating[0]!.querySelector(".sr-only"))).toBe("Rated 4.6 out of 5 from 128 reviews");
      // The visible numbers are hidden from screen readers: the sentence replaces them.
      expect(rating[0]!.querySelector(".sf-rating-average")!.getAttribute("aria-hidden")).toBe("true");
      expect(rating[0]!.querySelector(".sf-rating-count")!.getAttribute("aria-hidden")).toBe("true");
    });

    it("shows no rating while the store has no published review or reviews are off, or the product has none", async () => {
      const off = await renderCards(themeWith({ facts: "key-specs", action: "full" }), {}, EMPTY_STORE_SHAPE);
      expect(off.allFacts.querySelector(".sf-rating, .sc-stars")).toBeNull();
      const on = await renderCards(themeWith({}));
      expect(on.zeroFacts.querySelector(".sf-rating")).toBeNull();
      expect(on.onSale.querySelector(".sf-rating")).toBeNull();
    });
  });

  it("lists the condition with the pack size only when the merchant saved one", async () => {
    const used = await renderOne(themeWith({}), { ...PRODUCTS.allFacts, productCondition: "used" });
    expect(text(fact(used, "details"))).toBe("400 gm · Used");
    const unknown = await renderOne(themeWith({}), { ...PRODUCTS.allFacts, productCondition: null });
    expect(text(fact(unknown, "details"))).toBe("400 gm");
    // "New" is the default, and on a card it would read as a new-arrival badge.
    const fresh = await renderOne(themeWith({}), { ...PRODUCTS.allFacts, productCondition: "new" });
    expect(text(fact(fresh, "details"))).toBe("400 gm");
    const bare = await renderOne(themeWith({}), { productCondition: "used" });
    expect(text(fact(bare, "details"))).toBe("Used");
  });

  it("words the delivery fee from the stored rate, and free delivery wins", async () => {
    const theme = themeWith({ facts: "delivery" });
    const paid = await renderOne(theme, { ...PRODUCTS.allFacts, freeDelivery: false });
    expect(text(fact(paid, "delivery"))).toBe("Delivery from ৳60");
    const free = await renderOne(theme, { ...PRODUCTS.allFacts, freeDelivery: true });
    expect(text(fact(free, "delivery"))).toBe("Free delivery");
    const unknown = await renderOne(theme, { ...PRODUCTS.allFacts, freeDelivery: false, cardFacts: { ...(PRODUCTS.allFacts as unknown as { cardFacts: Record<string, unknown> }).cardFacts, delivery: null } });
    expect(fact(unknown, "delivery")).toBeNull();
  });

  describe("Bangla", () => {
    const BN = "bn-BD";
    it("speaks Bangla for every word the card adds when the store language is bn", async () => {
      const full = await renderCards(themeWith({ facts: "swatches", action: "full" }), {}, REVIEWED_STORE, BN);
      expect(text(full.onSale.querySelector(".sf-badge"))).toBe("-20%");
      expect(text(full.onSale.querySelector(".sf-price-current"))).toBe("ছাড়ের দাম ৳960");
      expect(text(full.onSale.querySelector(".sf-price-compare"))).toBe("নিয়মিত দাম ৳1,200");
      expect(text(full.bangla.querySelector(".sf-price-current"))).toBe("দাম ৳1,200");
      expect(text(full.withOptions.querySelector(".sf-price-current"))).toBe("দাম ৳1,200 থেকে");
      expect(text(full.onSale.querySelector("a.product-card-action"))).toBe("কার্টে যোগ করুন: Product sale");
      expect(text(hint(full.withOptions))).toBe("অপশন বেছে নিন");
      expect(text(hint(full.soldOut))).toBe("পণ্যটি দেখুন");
      expect(text(full.soldOut.querySelector(".sf-badge"))).toBe("স্টক শেষ");
      expect(text(full.allFacts.querySelector(".sf-rating .sr-only"))).toBe("৫-এর মধ্যে 4.6 রেটিং, 128টি রিভিউ");
      expect(text(fact(full.allFacts, "swatches")!.querySelector(".sr-only"))).toBe("রং: Navy, Light Blue, আরও 1টি রং");
      const delivery = await renderCards(themeWith({ facts: "delivery" }), {}, REVIEWED_STORE, BN);
      expect(text(fact(delivery.allFacts, "delivery"))).toBe("ফ্রি ডেলিভারি");
      const quick = await renderCards(themeWith({ action: "quick-add" }), {}, REVIEWED_STORE, BN);
      expect(text(quick.onSale.querySelector("a.product-card-quick"))).toBe("কার্টে যোগ করুন: Product sale");
      // No English chrome is left on a Bangla card.
      for (const card of [full.onSale, full.withOptions, full.soldOut, quick.onSale]) {
        expect(text(card)).not.toMatch(/Add to cart|Choose options|View product|Sale price|Regular price|Sold out|From /);
      }
    });

    it("falls back to English for any other language", async () => {
      for (const code of ["en", "en-US", "fr", undefined]) {
        const cards = await renderCards(themeWith({ action: "full" }), {}, REVIEWED_STORE, code);
        expect(text(cards.onSale.querySelector("a.product-card-action")), String(code)).toBe("Add to cart: Product sale");
      }
    });
  });

  it("uses the heading level it is given, h3 by default", async () => {
    const theme = themeWith({});
    expect((await renderOne(theme, {})).querySelector(".product-card-name")!.tagName).toBe("H3");
    expect((await renderOne(theme, {}, { headingLevel: "h3" })).querySelector(".product-card-name")!.tagName).toBe("H3");
    const h2 = await renderOne(theme, {}, { headingLevel: "h2" });
    expect(h2.querySelector(".product-card-name")!.tagName).toBe("H2");
    expect(h2.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(1);
    expect(text(h2.querySelector(".product-card-name"))).toBe("Product sale");
  });

  it("gives a product without a photo its initial in the same box, Bangla included", async () => {
    const cards = await renderCards(themeWith({}));
    for (const card of [cards.noPhoto, cards.bangla]) {
      expect(card.querySelector("img")).toBeNull();
      expect(card.querySelector(":scope > .product-card-media")).not.toBeNull();
      expect(card.querySelector("[data-card-placeholder]")!.getAttribute("aria-hidden")).toBe("true");
    }
    expect(text(cards.noPhoto.querySelector("[data-card-placeholder]"))).toBe("P");
    expect(text(cards.bangla.querySelector("[data-card-placeholder]"))).toBe(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(BANGLA_TITLE))[0]!.segment);
    expect(text(cards.bangla.querySelector(".product-card-link"))).toBe(BANGLA_TITLE);
    // One of our own uploads without renditions never goes on a card.
    expect(cards.original.querySelector("img")).toBeNull();
    expect(cards.original.querySelector("[data-card-placeholder]")).not.toBeNull();
  });

  describe("the photo", () => {
    const gridFor = (theme: StorefrontThemeDocument) => {
      const request = requestThemeFor(theme);
      return {
        spec: productGridSpec(request.layout.grid, request.layout.productCard.imageRatio),
        container: buildStorefrontThemeTokens(request.resolved)["theme-container-width"]!,
      };
    };

    it.each(STOREFRONT_DENSITIES.flatMap((density) =>
      STOREFRONT_IMAGE_RATIOS.flatMap((imageRatio) =>
        STOREFRONT_IMAGE_FITS.flatMap((imageFit) =>
          STOREFRONT_THEME_SURFACES.map((surface) => ({ density, imageRatio, imageFit, surface }))))))(
      "$density / $imageRatio / $imageFit / $surface: keeps the photo box fixed before the photo loads",
      async ({ density, imageRatio, imageFit, surface }) => {
        const theme = themeWith({ facts: "key-specs", action: "full", hoverImage: true }, { density, imageRatio, imageFit, surface });
        const cards = await renderCards(theme);
        const { width, height } = CARD_IMAGE_DIMENSIONS[imageRatio];
        for (const fixture of FIXTURES) {
          const card = cards[fixture];
          expect(card.getAttribute("data-fit")).toBe(imageFit);
          expect(card.getAttribute("data-surface")).toBe(surface);
          const media = card.querySelector(":scope > .product-card-media")!;
          expect(media).not.toBeNull();
          const photo = media.querySelector(":scope > img.product-card-photo");
          const hasPhoto = Boolean(PRODUCTS[fixture].imageUrl) && fixture !== "original";
          expect(Boolean(photo), fixture).toBe(hasPhoto);
          expect(Boolean(media.querySelector("[data-card-placeholder]")), fixture).toBe(!hasPhoto);
          if (photo) {
            // Intrinsic size = the token ratio's box: the browser reserves it before the bytes arrive.
            expect(photo.getAttribute("width")).toBe(String(width));
            expect(photo.getAttribute("height")).toBe(String(height));
            expect(photo.getAttribute("alt")).toBe(PRODUCTS[fixture].name);
          } else {
            expect(media.hasAttribute("data-hover-src")).toBe(false);
          }
          // The hover photo is never in the HTML: the box names it for the intent script.
          expect(media.querySelector(".product-card-hover-image")).toBeNull();
        }
      });

    it("names the hover photo only when the setting is on and the product has a photo", async () => {
      const hoverOf = (card: Element) => card.querySelector(".product-card-media")!.getAttribute("data-hover-src");
      const on = await renderCards(themeWith({ hoverImage: true }));
      expect(hoverOf(on.onSale)).toBe(image("sale-back"));
      expect(hoverOf(on.withOptions)).toBe(image("options-back"));
      expect(hoverOf(on.noPhoto)).toBeNull();
      expect(hoverOf(on.zeroFacts)).toBeNull();
      expect(on.onSale.querySelector(".product-card-media")!.hasAttribute("data-hover-max")).toBe(true);
      const off = await renderCards(themeWith({ hoverImage: false }));
      expect(hoverOf(off.onSale)).toBeNull();
      expect(off.onSale.querySelector(".product-card-media")!.hasAttribute("data-hover-max")).toBe(false);
    });

    it("asks for a photo sized to the slot, 12% smaller for a contained photo, and caps the srcset to what is drawn", async () => {
      const coverTheme = themeWith({}, { imageFit: "cover" });
      const containTheme = themeWith({}, { imageFit: "contain" });
      const cover = await renderCards(coverTheme);
      const contain = await renderCards(containTheme);
      const coverSizes = cover.onSale.querySelector("img")!.getAttribute("sizes")!;
      const containSizes = contain.onSale.querySelector("img")!.getAttribute("sizes")!;
      const coverGrid = gridFor(coverTheme);
      expect(coverSizes).toBe(capPhoneSizesDensity(scaleSizes(productCardImageSizes(coverGrid.spec, coverGrid.container, "grid", "grid", undefined, 0), 1)));
      const containGrid = gridFor(containTheme);
      expect(containSizes).toBe(capPhoneSizesDensity(scaleSizes(productCardImageSizes(containGrid.spec, containGrid.container, "grid", "grid", undefined, 0), 0.88)));
      expect(containSizes).not.toBe(coverSizes);
      const lastPx = (sizes: string) => Number(/(\d+(?:\.\d+)?)px$/.exec(sizes.trim())?.[1]);
      expect(lastPx(containSizes)).toBeLessThan(lastPx(coverSizes));
      // The srcset stops at the widest file the slot can use at 2x.
      const widths = (srcset: string | null) => (srcset ?? "1w").split(", ").map((entry) => Number(/ (\d+)w$/.exec(entry)?.[1] ?? 1));
      const coverWidths = widths(cover.onSale.querySelector("img")!.getAttribute("srcset"));
      const containWidths = widths(contain.onSale.querySelector("img")!.getAttribute("srcset"));
      expect(Math.max(...containWidths)).toBeLessThanOrEqual(Math.max(...coverWidths));
    });

    it("sizes list rows by the fixed photo column and honours an explicit `sizes`", async () => {
      const row = await renderCards(themeWith({}), { phoneLayout: "list-row" });
      expect(row.onSale.querySelector("img")!.getAttribute("sizes")).toMatch(/\(max-width: \d+px\) (?:calc\(\()?120px/);
      const custom = await renderCards(themeWith({}, { imageFit: "cover" }), { sizes: "(max-width: 600px) 50vw, 300px" });
      const img = custom.onSale.querySelector("img")!;
      expect(img.getAttribute("sizes")).toContain("50vw");
      expect(img.getAttribute("sizes")).toContain("300px");
    });

    it("loads the first row eagerly, the very first photos with high priority, and everything else lazily", async () => {
      const loadingOf = async (props: object) => {
        const photo = (await renderOne(themeWith({}), {}, props)).querySelector("img")!;
        return [photo.getAttribute("loading"), photo.getAttribute("fetchpriority"), photo.getAttribute("decoding")];
      };
      expect(await loadingOf({ index: 0, aboveFold: true })).toEqual(["eager", "high", "sync"]);
      expect(await loadingOf({ index: 1, aboveFold: true })).toEqual(["eager", "high", "sync"]);
      expect(await loadingOf({ index: 40, aboveFold: true })).toEqual(["lazy", null, "async"]);
      expect(await loadingOf({ index: 0, aboveFold: false })).toEqual(["lazy", null, "async"]);
      expect(await loadingOf({})).toEqual(["lazy", null, "async"]);
    });
  });

  it("uses the store's rows on phones when the listing asks for list rows", async () => {
    const theme = themeWith({});
    const locals = { storefrontTheme: Promise.resolve(requestThemeFor(theme)) };
    const html = await container.renderToString(ProductGrid, {
      props: { phoneLayout: "list-row" },
      locals,
      request: new Request("https://shop.test/"),
    });
    expect(parse(html).querySelector(".product-grid")!.getAttribute("data-phone-layout")).toBe("list-row");
    const plain = parse(await container.renderToString(ProductGrid, { props: {}, locals, request: new Request("https://shop.test/") }));
    expect(plain.querySelector(".product-grid")!.hasAttribute("data-phone-layout")).toBe(false);
  });

  it.each(["department-mall", "boutique", "marketplace", "daily-essentials", "showcase-landing"] as const)(
    "the %s preset renders the card its settings describe",
    async (id) => {
      const theme = storefrontTemplateTheme(id);
      const { facts, action } = theme.blocks.card.settings as { facts: StorefrontCardFacts; action: StorefrontCardAction };
      const cards = await renderCards(theme);
      expect(cards.onSale.getAttribute("data-action")).toBe(action);
      expect(cards.onSale.hasAttribute("data-card-variant")).toBe(false);
      expect(cards.onSale.querySelectorAll(".sf-badge")).toHaveLength(1);
      expect(cards.onSale.querySelector(".product-card-foot .sf-price")).not.toBeNull();
      expect(Boolean(cards.onSale.querySelector(".product-card-foot .product-card-action"))).toBe(action === "full");
      expect(Boolean(cards.onSale.querySelector(".product-card-media .product-card-quick"))).toBe(action === "quick-add");
      expect(factNames(cards.allFacts).filter((name) => name !== "details")).toEqual(facts === "none" ? [] : [facts]);
    },
  );
});

/** True when the card has no add control and no hint (a sold-out or ineligible product under quick add). */
function card_has_no_action(card: Element): boolean {
  return card.querySelector("[data-card-quick-add], [data-card-action-hint], .product-card-quick, .product-card-action") === null;
}
