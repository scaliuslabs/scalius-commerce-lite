// Tests for storefront modules: render a section, component or skin through the
// same batch protocol the storefront uses, with realistic fixture data. A
// skin's markup is held to its target's embed rule (a product_main skin must
// place exactly one buy form), as the storefront holds it.
//
//   import storefront from "./storefront";
//   import { renderSection, fixtureProductCard } from "@scalius/plugin-sdk/storefront/testing";
//
//   const html = renderSection(storefront, "hero", { heading: "Hello" });

import {
  STOREFRONT_COMPONENT_ABI,
  STOREFRONT_COMPONENT_LIMITS,
  STOREFRONT_SECTION_SKIN_PROJECTIONS,
  storefrontEmbedRule,
  type StorefrontComponentJob,
  type StorefrontComponentTarget,
  type StorefrontFooterData,
  type StorefrontHeaderData,
  type StorefrontImage,
  type StorefrontListingPage,
  type StorefrontModule,
  type StorefrontProductCard,
  type StorefrontProductCardData,
  type StorefrontProductPage,
  type StorefrontRenderContext,
  type StorefrontRenderJob,
  type StorefrontResolvedSettings,
  type StorefrontSectionSkinData,
  type StorefrontSectionSkinSettings,
  type StorefrontSkinJob,
  type StorefrontSkinnableSection,
  type StorefrontSkinTarget,
  type StorefrontSkinUnit,
  type StorefrontSpecification,
  type StorefrontTile,
} from "@scalius/shared/plugins/storefront-protocol";
import { splitStorefrontEmbeds } from "@scalius/shared/plugins/storefront-embeds";
import { storefrontSectionDefault, storefrontVisibleSection } from "@scalius/shared/storefront-theme/sections";
import { coreSectionSkinSettings, type CoreSectionResolver } from "@scalius/shared/storefront-theme/skins";
import { checkStorefrontHeaderHtml, type StorefrontHeaderCheckOptions } from "@scalius/shared/plugins/storefront-html-check";
import { sanitizePluginHtml } from "@scalius/shared/plugins/html";

export { checkStorefrontHeaderHtml } from "@scalius/shared/plugins/storefront-html-check";

/**
 * What the storefront shows of a component's markup (the host's sanitizer),
 * and how many elements and attributes it left out: assert `dropped` is 0.
 * `oversizedProps`, present only when there are some, names the islands
 * whose props it left out for being over
 * `STOREFRONT_COMPONENT_LIMITS.islandPropsBytes` (they mount with none).
 */
export function storefrontShown(html: string, pluginId: string): { html: string; dropped: number; oversizedProps?: string[] } {
  const result = sanitizePluginHtml(html, { pluginId });
  if (!result.ok) throw new Error(`The storefront would show nothing: ${result.reason}.`);
  return { html: result.html, dropped: result.dropped, ...(result.oversizedProps.length > 0 ? { oversizedProps: result.oversizedProps } : {}) };
}

/** The problem an island's oversized props make, in words an author can act on; none when every island's props fit. */
function islandPropsIssues(html: string): string[] {
  const result = sanitizePluginHtml(html, { pluginId: "app.check" });
  if (!result.ok) return [];
  return result.oversizedProps.map((island) => `The island ${island} gets no props: its data-props is over ${STOREFRONT_COMPONENT_LIMITS.islandPropsBytes} bytes (islandPropsBytes). Pass less, or load the rest from the app's routes with context.fetchApp.`);
}

/** Assert declared header capabilities without requiring search, nav or account. */
export function assertHeaderContract(html: string, options: StorefrontHeaderCheckOptions = {}): void {
  const issues = checkStorefrontHeaderHtml(html, options);
  if (issues.length) throw new Error(`Invalid header markup: ${issues.join(" ")}`);
}

export function fixtureContext(overrides: Partial<StorefrontRenderContext> = {}): StorefrontRenderContext {
  return {
    store: { name: "Acme Store", currency: "BDT", locale: "en-BD", language: "en", timeZone: "Asia/Dhaka", logo: null },
    page: { kind: "home", path: "/" },
    assets: "/_x/acme.theme/0123456789abcdef/",
    preview: false,
    ...overrides,
  };
}

/** The sample product's specifications, as the store's table lists them (a number's value carries its unit). */
const SAMPLE_SPECIFICATIONS: StorefrontSpecification[] = [
  { group: "Fabric", label: "Material", value: "Linen", unit: null, keySpec: true },
  { group: "Fabric", label: "Weight", value: "180 gsm", unit: "gsm", keySpec: true },
  { group: "Fit", label: "Sleeve", value: "Long", unit: null, keySpec: false },
];

/** A card's key specs and its fact lines, written from the same rows as the store writes them. */
function cardKeySpecs(specifications: readonly StorefrontSpecification[]): Pick<StorefrontProductCard, "facts" | "keySpecs"> {
  const keySpecs = specifications.filter((row) => row.keySpec).slice(0, 4).map(({ label, value, unit }) => ({ label, value, unit }));
  return { facts: keySpecs.map((row) => `${row.label}: ${row.value}`), keySpecs };
}

export function fixtureProductCard(overrides: Partial<StorefrontProductCard> = {}): StorefrontProductCard {
  return {
    id: "prod_1",
    title: "Linen shirt",
    url: "/products/linen-shirt",
    price: { amountMinor: 120000, currency: "BDT", formatted: "৳1,200" },
    compareAt: { amountMinor: 150000, currency: "BDT", formatted: "৳1,500" },
    priceVaries: false,
    percentOff: 20,
    image: { url: "https://media.example.com/shirt-480.webp", srcset: "https://media.example.com/shirt-480.webp 480w, https://media.example.com/shirt-960.webp 960w", width: 960, height: 1200, alt: "Linen shirt" },
    hoverImage: null,
    soldOut: false,
    rating: { average: 4.6, count: 12 },
    quickAdd: true,
    needsOptions: false,
    ...cardKeySpecs(SAMPLE_SPECIFICATIONS),
    fields: {},
    ...overrides,
  };
}

export function fixtureHeaderData(overrides: Partial<StorefrontHeaderData> = {}): StorefrontHeaderData {
  return {
    store: { name: "Acme Store", url: "/", logo: null, darkLogo: null, logoWidth: 140 },
    menu: [
      { title: "New in", url: "/collections/new", children: [] },
      { title: "Women", url: "/categories/women", children: [{ title: "Dresses", url: "/categories/dresses", children: [] }] },
    ],
    categories: [{ title: "Women", url: "/categories/women", children: [] }],
    announcement: { text: "Free delivery over ৳2,000", url: null },
    routes: { home: "/", search: "/search", cart: "/cart", account: "/account" },
    searchParam: "q",
    ...overrides,
  };
}

export function fixtureFooterData(overrides: Partial<StorefrontFooterData> = {}): StorefrontFooterData {
  return {
    store: {
      name: "Acme Store", url: "/", logo: null, darkLogo: null, logoWidth: 140, footerLogo: null,
      phone: "+8801700000000", email: "hello@acme.example", address: "Dhaka", social: [{ network: "facebook", url: "https://facebook.com/acme" }],
    },
    menus: [{ title: "Help", items: [{ title: "Shipping", url: "/pages/shipping", children: [] }] }],
    policies: [{ title: "Privacy", url: "/policies/privacy" }],
    newsletter: true,
    routes: { home: "/", newsletter: "/newsletter" },
    year: 2026,
    ...overrides,
  };
}

export function fixtureProductPage(overrides: Partial<StorefrontProductPage["product"]> = {}): StorefrontProductPage {
  const card = fixtureProductCard();
  return {
    product: {
      id: card.id,
      title: card.title,
      url: card.url,
      brand: { title: "Acme", url: "/brands/acme" },
      descriptionHtml: "<p>Breathable linen, cut for the heat.</p>",
      media: card.image ? [card.image] : [],
      price: card.price,
      compareAt: card.compareAt,
      priceVaries: false,
      availability: "in_stock",
      rating: card.rating,
      options: [{ name: "Size", values: [{ label: "M", swatch: null }, { label: "L", swatch: null }] }],
      variants: [
        { id: "sku_m", title: "M", options: ["M"], price: card.price, compareAt: card.compareAt, available: true, image: null },
        { id: "sku_l", title: "L", options: ["L"], price: card.price, compareAt: card.compareAt, available: false, image: null },
      ],
      fields: {},
      breadcrumbs: [{ title: "Home", url: "/" }, { title: "Shirts", url: "/categories/shirts" }, { title: card.title, url: card.url }],
      specifications: SAMPLE_SPECIFICATIONS,
      ...overrides,
    },
  };
}

export function fixtureListingPage(overrides: Partial<StorefrontListingPage> = {}): StorefrontListingPage {
  return {
    kind: "category",
    title: "Shirts",
    descriptionHtml: "<p>Shirts for every day.</p>",
    image: null,
    cards: [fixtureProductCard(), fixtureProductCard({ id: "prod_2", title: "Oxford shirt", quickAdd: false, compareAt: null, percentOff: null })],
    total: 2,
    totalIsCapped: false,
    page: 1,
    pageCount: 1,
    breadcrumbs: [{ title: "Home", url: "/" }],
    fields: {},
    ...overrides,
  };
}

/** What the fixture store resolves a section's references to: the fixture card, photo and facts. */
const fixtureSectionResolver: CoreSectionResolver = {
  image: (mediaId) => ({ ...fixtureProductCard().image!, alt: `Photo ${mediaId}` }),
  products: () => ({
    title: "New arrivals",
    url: "/collections/new",
    cards: [fixtureProductCard(), fixtureProductCard({ id: "prod_2", title: "Oxford shirt", quickAdd: false, compareAt: null, percentOff: null })],
  }),
  tiles: (kind, ids) => ids.map((id, index) => ({
    id,
    title: `${kind === "category" ? "Category" : "Collection"} ${index + 1}`,
    url: `/${kind === "category" ? "categories" : "collections"}/${id}`,
    image: fixtureProductCard().image,
    cards: kind === "collection" ? [fixtureProductCard()] : [],
  })),
  promotion: () => ({ endsAt: "2026-12-31T18:00:00.000Z" }),
  deliveryFacts: () => [
    { title: "Delivery in Dhaka", detail: "1-2 days" },
    { title: "Cash on delivery", detail: "Pay when it arrives" },
  ],
  objectField: () => [],
};

/** The settings a section skin of `type` gets: the projection of a new section of that type. */
type SectionSkinSettingsOf<Type extends StorefrontSkinnableSection> = StorefrontSectionSkinSettings[Type];

/**
 * A core section's projection as the store hands it to a `section:<type>`
 * skin, at the projection's version: the settings of a new section of that
 * type (core's own defaults) mapped by the host's own mapper
 * (`coreSectionSkinSettings`), so every field the sealed type
 * `StorefrontSectionSkinSettings[type]` declares is present. References
 * resolve to fixture data (a product source to two cards, a delivery-facts
 * source to two facts). `settings` replaces top-level fields of the
 * projection; pass the values your test is about.
 */
export function fixtureSectionSkinData<Type extends StorefrontSkinnableSection>(
  type: Type,
  settings: Partial<SectionSkinSettingsOf<Type>> = {},
): StorefrontSectionSkinData<SectionSkinSettingsOf<Type>> {
  return sectionSkinData(type, settings, fixtureSectionResolver, [{ id: "brand_1", title: "Acme", url: "/brands/acme", image: fixtureProductCard().image, cards: [] }]);
}

function sectionSkinData<Type extends StorefrontSkinnableSection>(
  type: Type,
  settings: Partial<SectionSkinSettingsOf<Type>>,
  resolver: CoreSectionResolver,
  brands: StorefrontTile[],
): StorefrontSectionSkinData<SectionSkinSettingsOf<Type>> {
  if (!Object.hasOwn(STOREFRONT_SECTION_SKIN_PROJECTIONS, type)) throw new Error(`${type} is not a core section a skin can draw.`);
  const section = storefrontVisibleSection(storefrontSectionDefault(type, type));
  const projection = coreSectionSkinSettings(section, resolver);
  return {
    type,
    version: STOREFRONT_SECTION_SKIN_PROJECTIONS[type],
    settings: { ...projection, ...settings } as SectionSkinSettingsOf<Type>,
    // A brand wall's brands, and a collections section's fallback products.
    tiles: type === "brand_wall" ? brands : [],
    cards: type === "collections" ? resolver.products({} as never).cards : [],
  };
}

/** The projection a skin target gets (a `section:<type>` target: the section's). */
export type SkinData<Target extends StorefrontSkinTarget> = Target extends StorefrontSkinUnit
  ? Extract<StorefrontSkinJob, { target: Target }>["data"]
  : Target extends `section:${infer Type extends StorefrontSkinnableSection}`
    ? StorefrontSectionSkinData<SectionSkinSettingsOf<Type>>
    : StorefrontSectionSkinData;

/** The fixture projection a skin target gets. */
export function fixtureSkinData(target: StorefrontSkinTarget): StorefrontSkinJob["data"] {
  switch (target) {
    case "header": return fixtureHeaderData();
    case "footer": return fixtureFooterData();
    case "product_card": return { product: fixtureProductCard(), position: 0, aboveFold: true };
    case "product_main": return fixtureProductPage();
    case "listing_main": return fixtureListingPage();
    default: return fixtureSectionSkinData(target.slice("section:".length) as StorefrontSkinnableSection) as StorefrontSectionSkinData;
  }
}

// ── Fixture stores ──────────────────────────────────────────────────────

/**
 * The stores `pnpm plugin preview` renders an app on, so a theme that works
 * only on its developer's store shows its breakage on the developer's
 * machine: `sample` (the fixtures above), `empty` (a new store: no products,
 * categories, menus, logo, policies or contact details, and a bare product
 * where one must exist) and `other` (another shop with its own name, logo,
 * catalogue, brand and currency).
 */
export const FIXTURE_STORES = ["sample", "empty", "other"] as const;
export type FixtureStoreName = (typeof FIXTURE_STORES)[number];

export interface FixtureStore {
  name: FixtureStoreName;
  /** One line for a preview heading. */
  description: string;
  context(overrides?: Partial<StorefrontRenderContext>): StorefrontRenderContext;
  /** What a `products` setting resolves to in this store. */
  productCards(): StorefrontProductCard[];
  /** What an `image` setting resolves to in this store. */
  image(): StorefrontImage | null;
  productPage(overrides?: Partial<StorefrontProductPage["product"]>): StorefrontProductPage;
  /** The projection a skin target gets in this store. */
  skinData(target: StorefrontSkinTarget): StorefrontSkinJob["data"];
}

const SAMPLE_STORE: FixtureStore = {
  name: "sample",
  description: "A sample shop: Acme Store, clothing, prices in BDT.",
  context: (overrides) => fixtureContext(overrides),
  productCards: () => fixtureSectionResolver.products({} as never).cards,
  image: () => fixtureProductCard().image,
  productPage: (overrides) => fixtureProductPage(overrides),
  skinData: (target) => fixtureSkinData(target),
};

/** A product with nothing optional: no photo, price cut, rating, brand, description or options. */
function bareCard(overrides: Partial<StorefrontProductCard> = {}): StorefrontProductCard {
  return fixtureProductCard({
    id: "prod_bare", title: "Untitled product", url: "/products/untitled-product",
    compareAt: null, percentOff: null, image: null, hoverImage: null, rating: null, quickAdd: true, facts: [], keySpecs: [], ...overrides,
  });
}

const emptySectionResolver: CoreSectionResolver = {
  image: () => null,
  products: () => ({ title: "", url: null, cards: [] }),
  tiles: () => [],
  promotion: () => null,
  deliveryFacts: () => [],
  objectField: () => [],
};

const EMPTY_STORE: FixtureStore = {
  name: "empty",
  description: "A new store: no products, categories, menus, logo, policies or contact details.",
  context: (overrides) => fixtureContext({ store: { name: "New Store", currency: "BDT", locale: "en-BD", language: "en", timeZone: "Asia/Dhaka", logo: null }, ...overrides }),
  productCards: () => [],
  image: () => null,
  productPage: (overrides) => {
    const card = bareCard();
    return {
      product: {
        id: card.id, title: card.title, url: card.url, brand: null, descriptionHtml: "", media: [],
        price: card.price, compareAt: null, priceVaries: false, availability: "in_stock", rating: null,
        options: [], variants: [{ id: "sku_bare", title: card.title, options: [], price: card.price, compareAt: null, available: true, image: null }],
        fields: {}, breadcrumbs: [{ title: "Home", url: "/" }, { title: card.title, url: card.url }], specifications: [],
        ...overrides,
      },
    };
  },
  skinData: (target) => {
    switch (target) {
      case "header": return fixtureHeaderData({ store: { name: "New Store", url: "/", logo: null, darkLogo: null, logoWidth: 140 }, menu: [], categories: [], announcement: null, searchScopes: [] });
      case "footer": return fixtureFooterData({
        store: { name: "New Store", url: "/", logo: null, darkLogo: null, logoWidth: 140, footerLogo: null, phone: null, email: null, address: null, social: [] },
        menus: [], policies: [], newsletter: false,
      });
      case "product_card": return { product: bareCard(), position: 0, aboveFold: true };
      case "product_main": return EMPTY_STORE.productPage();
      case "listing_main": return fixtureListingPage({ title: "All products", descriptionHtml: null, cards: [], total: 0, children: [] });
      default: return sectionSkinData(target.slice("section:".length) as StorefrontSkinnableSection, {}, emptySectionResolver, []) as StorefrontSectionSkinData;
    }
  },
};

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD", formatted: `$${(amountMinor / 100).toFixed(2)}` });
const otherImage = (name: string, alt: string): StorefrontImage => ({
  url: `https://media.example.com/harbor/${name}-640.webp`,
  srcset: `https://media.example.com/harbor/${name}-640.webp 640w, https://media.example.com/harbor/${name}-1280.webp 1280w`,
  width: 1280, height: 1280, alt,
});
const OTHER_LOGO: StorefrontImage = { url: "https://media.example.com/harbor/logo.png", srcset: "https://media.example.com/harbor/logo.png 320w", width: 320, height: 96, alt: "Harbor & Pine" };
/** Its light version, for dark pages. */
const OTHER_DARK_LOGO: StorefrontImage = { url: "https://media.example.com/harbor/logo-light.png", srcset: "https://media.example.com/harbor/logo-light.png 320w", width: 320, height: 96, alt: "Harbor & Pine" };

const OTHER_SPECIFICATIONS: StorefrontSpecification[] = [
  { group: "Size", label: "Diameter", value: "10 in", unit: "in", keySpec: true },
  { group: "Size", label: "Weight", value: "5.1 lb", unit: "lb", keySpec: false },
  { group: "Care", label: "Material", value: "Cast iron", unit: null, keySpec: true },
  { group: "Care", label: "Oven safe to", value: "500 °F", unit: "°F", keySpec: true },
];

function otherCard(overrides: Partial<StorefrontProductCard> = {}): StorefrontProductCard {
  return fixtureProductCard({
    id: "prod_skillet", title: "Cast-iron skillet", url: "/products/cast-iron-skillet",
    price: usd(4800), compareAt: null, percentOff: null, priceVaries: true,
    image: otherImage("skillet", "Cast-iron skillet"), rating: { average: 4.9, count: 312 }, quickAdd: false, needsOptions: true,
    ...cardKeySpecs(OTHER_SPECIFICATIONS),
    ...overrides,
  });
}

function otherCards(): StorefrontProductCard[] {
  return [
    otherCard(),
    otherCard({ id: "prod_board", title: "End-grain cutting board, walnut", url: "/products/walnut-board", price: usd(7200), compareAt: usd(9000), percentOff: 20, priceVaries: false, image: otherImage("board", "Walnut cutting board"), quickAdd: true, needsOptions: false, facts: [], keySpecs: [] }),
    otherCard({ id: "prod_kettle", title: "Enamel kettle", url: "/products/enamel-kettle", price: usd(3900), priceVaries: false, image: otherImage("kettle", "Enamel kettle"), rating: null, soldOut: true, quickAdd: false, needsOptions: false, facts: [], keySpecs: [] }),
  ];
}

const otherSectionResolver: CoreSectionResolver = {
  image: (mediaId) => otherImage(`media-${mediaId}`, "Kitchen shelf"),
  products: () => ({ title: "Kitchen", url: "/categories/kitchen", cards: otherCards() }),
  tiles: (kind, ids) => ids.map((id, index) => ({
    id, title: kind === "category" ? ["Kitchen", "Garden", "Outdoor"][index % 3]! : `Season ${index + 1}`,
    url: `/${kind === "category" ? "categories" : "collections"}/${id}`, image: otherImage(`tile-${index}`, "Tile"),
    cards: kind === "collection" ? [otherCard()] : [],
  })),
  promotion: () => ({ endsAt: "2026-11-30T05:00:00.000Z" }),
  deliveryFacts: () => [{ title: "Ships in 2 days", detail: "Free over $75" }],
  objectField: () => [],
};

const OTHER_STORE: FixtureStore = {
  name: "other",
  description: "Another shop: Harbor & Pine, kitchenware, a logo, prices in USD.",
  context: (overrides) => fixtureContext({ store: { name: "Harbor & Pine", currency: "USD", locale: "en-US", language: "en", timeZone: "America/New_York", logo: OTHER_LOGO }, ...overrides }),
  productCards: otherCards,
  image: () => otherImage("hero", "Kitchen shelf"),
  productPage: (overrides) => {
    const card = otherCard();
    return {
      product: {
        id: card.id, title: card.title, url: card.url, brand: { title: "Harbor Goods", url: "/brands/harbor-goods" },
        descriptionHtml: "<p>Pre-seasoned and oven-safe to 500°F.</p>", media: [card.image!, otherImage("skillet-side", "Skillet from the side")],
        price: card.price, compareAt: null, priceVaries: true, availability: "in_stock", rating: card.rating,
        options: [{ name: "Diameter", values: [{ label: "10 in", swatch: null }, { label: "12 in", swatch: null }] }],
        variants: [
          { id: "sku_10", title: "10 in", options: ["10 in"], price: usd(4800), compareAt: null, available: true, image: null },
          { id: "sku_12", title: "12 in", options: ["12 in"], price: usd(5800), compareAt: null, available: true, image: null },
        ],
        fields: {}, breadcrumbs: [{ title: "Home", url: "/" }, { title: "Kitchen", url: "/categories/kitchen" }, { title: card.title, url: card.url }], specifications: OTHER_SPECIFICATIONS,
        ...overrides,
      },
    };
  },
  skinData: (target) => {
    switch (target) {
      case "header": return fixtureHeaderData({
        store: { name: "Harbor & Pine", url: "/", logo: OTHER_LOGO, darkLogo: OTHER_DARK_LOGO, logoWidth: 180 },
        menu: [{ title: "Kitchen", url: "/categories/kitchen", children: [] }, { title: "Garden", url: "/categories/garden", children: [] }, { title: "Journal", url: "/blog", children: [] }],
        categories: [{ title: "Kitchen", url: "/categories/kitchen", children: [] }, { title: "Garden", url: "/categories/garden", children: [] }],
        announcement: { text: "Free shipping over $75", url: "/categories/kitchen" },
      });
      case "footer": return fixtureFooterData({
        store: { name: "Harbor & Pine", url: "/", logo: OTHER_LOGO, darkLogo: OTHER_DARK_LOGO, logoWidth: 180, footerLogo: null, phone: "+1 207 555 0142", email: "hello@harborpine.example", address: "Portland, Maine", social: [{ network: "instagram", url: "https://instagram.com/harborpine" }] },
        menus: [{ title: "Shop", items: [{ title: "Kitchen", url: "/categories/kitchen", children: [] }] }],
        policies: [{ title: "Returns", url: "/policies/returns" }],
      });
      case "product_card": return { product: otherCard(), position: 0, aboveFold: true };
      case "product_main": return OTHER_STORE.productPage();
      case "listing_main": return fixtureListingPage({ title: "Kitchen", descriptionHtml: "<p>Tools that last.</p>", cards: otherCards(), total: 3, children: [] });
      default: return sectionSkinData(target.slice("section:".length) as StorefrontSkinnableSection, {}, otherSectionResolver, [{ id: "brand_h", title: "Harbor Goods", url: "/brands/harbor-goods", image: OTHER_LOGO, cards: [] }]) as StorefrontSectionSkinData;
    }
  },
};

/** One of the preview's fixture stores. Render your skins and sections over all three in your own tests too. */
export function fixtureStore(name: FixtureStoreName): FixtureStore {
  switch (name) {
    case "sample": return SAMPLE_STORE;
    case "empty": return EMPTY_STORE;
    case "other": return OTHER_STORE;
    default: throw new Error(`${String(name)} is not a fixture store (${FIXTURE_STORES.join(", ")}).`);
  }
}

/** What the storefront would do with a skin's markup: the problems that make it draw the core unit instead. */
export function checkSkinHtml(target: StorefrontSkinTarget, html: string): string[] {
  const split = splitStorefrontEmbeds(html, storefrontEmbedRule(target));
  const issues = split.missing.map((kind) => `A ${target} skin must place <scalius-embed kind="${kind}"> (the SDK's ${kind === "buy_form" ? "<BuyForm />" : kind}); without it the store draws its own.`);
  if (split.dropped > 0) {
    const rule = storefrontEmbedRule(target);
    const named = [
      ...(rule.slots ? [`slot names ${rule.slots.join(", ")}`] : []),
      ...(rule.productModules ? [`product_module names ${rule.productModules.join(", ")}`] : []),
    ];
    issues.push(`${split.dropped} embed(s) render nothing here: ${target} allows ${Object.keys(rule.allowed).join(", ") || "none"}${named.length ? ` (${named.join("; ")}, each once)` : ""}.`);
  }
  issues.push(...islandPropsIssues(html));
  return issues;
}

export interface RenderOptions extends StorefrontHeaderCheckOptions {
  context?: Partial<StorefrontRenderContext>;
}

function renderOne(module: StorefrontModule, job: StorefrontRenderJob, options: RenderOptions): string {
  const reply = module.render({ abi: STOREFRONT_COMPONENT_ABI, context: fixtureContext(options.context), jobs: [job] });
  const result = reply.results[0];
  if (!result) throw new Error("The module answered no result.");
  if ("error" in result) throw new Error(result.error);
  return result.html;
}

/** A component section's HTML (throws what the component threw). */
export function renderSection(module: StorefrontModule, type: string, settings: StorefrontResolvedSettings = {}, options: RenderOptions = {}): string {
  return renderOne(module, { id: "job_1", kind: "section", type, instanceId: `app-${type}`, settings }, options);
}

/**
 * A component's HTML at one of its targets: in a product slot over the
 * fixture product page (or `data`), in a card slot over the fixture card (or
 * `data`), on `page` with `props` (what the proxy route answers). Throws
 * when the storefront would drop it: a component places no embed (not even
 * a slot).
 */
export function renderComponent(
  module: StorefrontModule,
  type: string,
  target: StorefrontComponentTarget,
  settings: StorefrontResolvedSettings = {},
  options: RenderOptions & { data?: StorefrontProductPage | StorefrontProductCardData; props?: Record<string, unknown> } = {},
): string {
  const job = (target === "page"
    ? { target, props: options.props ?? {} }
    : target.startsWith("product.")
      ? { target, instanceId: `app-${type}`, data: options.data ?? fixtureProductPage() }
      : target.startsWith("product_card.")
        ? { target, data: options.data ?? fixtureSkinData("product_card") }
        : { target }) as Omit<StorefrontComponentJob, "id" | "kind" | "type" | "settings">;
  const html = renderOne(module, { id: "job_1", kind: "component", type, settings, ...job } as StorefrontComponentJob, options);
  const split = splitStorefrontEmbeds(html, storefrontEmbedRule("component"));
  if (split.dropped > 0) throw new Error(`Component ${JSON.stringify(type)} (${target}): ${split.dropped} embed(s) render nothing in a component.`);
  return html;
}

/**
 * A skin's HTML over its target's fixture projection (or yours). Throws
 * when the storefront would draw the core unit instead: a missing required
 * embed, an embed the target does not allow, or (headers) invalid markup.
 */
export function renderSkin<Target extends StorefrontSkinTarget>(
  module: StorefrontModule,
  component: string,
  target: Target,
  settings: StorefrontResolvedSettings = {},
  data?: SkinData<Target>,
  options: RenderOptions = {},
): string {
  const job = {
    id: "job_1", kind: "skin", target, component, settings,
    data: data ?? fixtureSkinData(target),
    ...(target.startsWith("section:") ? { instanceId: target.slice("section:".length) } : {}),
  } as StorefrontSkinJob;
  const html = renderOne(module, job, options);
  const issues = checkSkinHtml(target, html);
  if (target === "header") {
    try {
      assertHeaderContract(html, options);
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  if (issues.length > 0) throw new Error(`Skin ${JSON.stringify(component)} (${target}): ${issues.join(" ")}`);
  return html;
}

export function renderHeader(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, data: Partial<StorefrontHeaderData> = {}, options: RenderOptions = {}): string {
  return renderSkin(module, component, "header", settings, fixtureHeaderData(data), options);
}

export function renderFooter(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, data: Partial<StorefrontFooterData> = {}, options: RenderOptions = {}): string {
  return renderSkin(module, component, "footer", settings, fixtureFooterData(data), options);
}

export function renderProductCard(module: StorefrontModule, component: string, settings: StorefrontResolvedSettings = {}, product: Partial<StorefrontProductCard> = {}, options: RenderOptions = {}): string {
  return renderSkin(module, component, "product_card", settings, { product: fixtureProductCard(product), position: 0, aboveFold: false }, options);
}
