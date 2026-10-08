/**
 * The fixture API: answers every read a storefront page makes (the batch
 * and its parts, single reads) for one gallery entry, in the API's public
 * envelope. An unknown read answers 404 and is recorded, so the gallery
 * index can show what a page asked for and did not get.
 */
import {
  HOME_PRODUCT_LIST_LIMIT,
  homeSectionRequests,
  storeShapeFromFacts,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { GalleryEntry } from "./entries";
import { fixtureProductSoldOut } from "./cart-seed";
import {
  BANGLA_STORE_NAME,
  FIXTURE_POLICIES,
  STORE_NAME,
  cardProducts,
  categoryDetail,
  fixtureBrands,
  fixtureBusiness,
  fixtureCategoryTree,
  fixtureCollection,
  fixtureFacets,
  fixtureFooterMenus,
  fixtureMenu,
  fixtureOrigin,
  fixturePage,
  fixtureShippingMethods,
  homeCategory,
  mediaAsset,
  productDetail,
  productScenarioOf,
} from "./fixtures";
import { fixtureMetaobject, metaobjectMediaIds } from "./metaobjects";

/**
 * The fixture API lives on the gallery server under the entry's id, so the
 * page's server reads and its browser reads (the cart, recommendations) both
 * reach the entry's fixtures: `<origin>/__gallery/api/<entry id>/api/v1/...`.
 */
export const GALLERY_API_PREFIX = "/__gallery/api/";

export function galleryApiBase(origin: string, entryId: string): string {
  return `${origin}${GALLERY_API_PREFIX}${entryId}`;
}

/** The API path of a fixture API URL path (`/__gallery/api/<id>/api/v1/x` is `/api/v1/x`). */
function apiPath(path: string): string {
  return path.startsWith(GALLERY_API_PREFIX) ? path.slice(GALLERY_API_PREFIX.length).replace(/^[^/]*/, "") : path;
}
export const GALLERY_LOGO_ID = "logo-nakshi-bazar";

const envelope = (data: unknown) => JSON.stringify({ success: true, data });

/** The document the entry's pages read (with its logo when the scenario has one). */
export function entryTheme(entry: GalleryEntry): StorefrontThemeDocument {
  if (!entry.scenario.logo) return entry.theme;
  return { ...entry.theme, brand: { ...entry.theme.brand, logo: GALLERY_LOGO_ID } };
}

function storeShape() {
  return storeShapeFromFacts({
    productCount: 1240,
    skuCount: 4800,
    topCategoryCount: 18,
    categoryDepth: 3,
    categoryGroups: 7,
    menu: fixtureMenu(),
    brandCount: 24,
    hasCollections: true,
    hasDeliveryMethods: true,
    hasKeySpecs: true,
    hasEmiPlans: true,
    hasDigitalLines: true,
    hasReviews: true,
    hasContentBlocks: true,
  });
}

function markets(entry: GalleryEntry) {
  // A store that also delivers to the United Kingdom: the checkout offers the country and its free-text fields.
  if (entry.scenario.addressApp) {
    return { markets: [{ id: "mkt_backup", handle: "bangladesh", name: "Bangladesh and United Kingdom", isBackup: true, countries: ["BD", "GB"], presences: [{ value: "", locale: "en" }] }] };
  }
  if (entry.scenario.locale === "bn") {
    return { markets: [{ id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "bn" }, { value: "en", locale: "en" }] }] };
  }
  if (entry.scenario.locale === "ar") {
    return {
      markets: [
        { id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "en" }] },
        { id: "mkt_ae", handle: "uae", name: "United Arab Emirates", isBackup: false, countries: ["AE"], presences: [{ value: "ar-ae", locale: "ar" }] },
      ],
    };
  }
  return undefined;
}

function layout(entry: GalleryEntry) {
  const theme = entryTheme(entry);
  const business = fixtureBusiness();
  return {
    analytics: [],
    navigation: fixtureMenu(),
    categoryTree: fixtureCategoryTree(),
    footerMenus: fixtureFooterMenus(),
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 2, priceIncrementMinor: 100 },
    ...(markets(entry) ? { markets: markets(entry) } : {}),
    theme,
    brand: { logo: theme.brand.logo ? mediaAsset(GALLERY_LOGO_ID, `${STORE_NAME} logo`) : null, footerLogo: null, favicon: null },
    storeShape: storeShape(),
    business: entry.scenario.locale === "bn" ? { ...business, companyName: BANGLA_STORE_NAME } : business,
    seo: { socialImage: "" },
    // The API serves the store language; a Bangla store speaks Bangla in its chrome too.
    ...(entry.scenario.locale === "bn" ? { storefrontCopy: { languageCode: "bn" } } : {}),
    timeZone: "Asia/Dhaka",
    // The Platform settings take origins: the gallery server answers `/api/v1`
    // on its own origin (by the page's Referer in the browser), so the page's
    // browser reads (the cart's delivery rates) have an API to call.
    platform: { apiUrl: fixtureOrigin(), storefrontUrl: fixtureOrigin() },
    policies: FIXTURE_POLICIES,
    ...(entry.scenario.checkoutBlocks ? { appBlockPages: ["checkout"] } : {}),
    ...(entry.scenario.addressApp ? { appServices: { search: null, address: { id: ADDRESS_APP_ID, countries: ["GB"] }, signIn: [] } } : {}),
  };
}

/** The address app the gallery store has installed (the layout names it; the checkout suggests through it). */
export const ADDRESS_APP_ID = "acme.addresses/lookup";
const ADDRESS_SUGGESTIONS = [
  { id: "addr_1", text: "10 Downing Street", secondaryText: "Westminster, London SW1A 2AA" },
  { id: "addr_2", text: "10 Downing Place", secondaryText: "Cambridge CB2 3NY" },
  { id: "addr_3", text: "10 Downing Road", secondaryText: "Manchester M11 4JT" },
];
const RESOLVED_ADDRESSES: Record<string, Record<string, string>> = {
  addr_1: { countryCode: "GB", line1: "10 Downing Street", dependentLocality: "Westminster", locality: "London", adminArea: "England", postalCode: "SW1A 2AA" },
  addr_2: { countryCode: "GB", line1: "10 Downing Place", locality: "Cambridge", adminArea: "England", postalCode: "CB2 3NY" },
  addr_3: { countryCode: "GB", line1: "10 Downing Road", locality: "Manchester", adminArea: "England", postalCode: "M11 4JT" },
};

/**
 * The POSTs the checkout page makes from the browser: the discount preview and
 * abandoned-checkout capture (nothing to apply or save in the gallery), and the
 * address app's suggest and resolve. null for any other request.
 */
async function browserPostAnswer(entry: GalleryEntry, path: string, request: Request): Promise<unknown | null> {
  if (request.method !== "POST") return null;
  if (path === "/api/v1/discounts/validate") return { totalDiscount: 0, discounts: [], offers: [], rejectedCodes: [] };
  if (path === "/api/v1/abandoned-checkouts") return { saved: true };
  if (!entry.scenario.addressApp) return null;
  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (path === "/api/v1/address-rules/autocomplete/suggest") return { suggestions: ADDRESS_SUGGESTIONS };
  if (path === "/api/v1/address-rules/autocomplete/resolve") return { address: RESOLVED_ADDRESSES[body.id ?? ""] ?? null };
  return null;
}

/** The section data a list of sections reads (homepage, landing and template parts). */
function sectionData(entry: GalleryEntry, sections: readonly StorefrontSection[]) {
  const requests = homeSectionRequests(sections);
  const bangla = entry.scenario.locale === "bn";
  // A type that is private or gone is missing, as the API leaves it out.
  const metaobjects = (requests.metaobjects ?? []).flatMap((request) => fixtureMetaobject(request.definitionId, request.limit) ?? []);
  return {
    lists: requests.lists.map((list, index) => ({
      key: list.key,
      products: cardProducts(Math.min(list.limit, HOME_PRODUCT_LIST_LIMIT), index * 5, { bangla }),
      category: list.source.kind === "category" ? { id: list.source.categoryId, name: "Sarees", slug: "sarees", canonicalPath: null } : null,
      collection: list.source.kind === "collection" ? { id: list.source.collectionId, title: "Eid edit" } : null,
    })),
    media: [...new Set([...requests.mediaIds, ...metaobjectMediaIds(metaobjects)])].map((id) => mediaAsset(id, `Photo: ${id.replace(/-/g, " ")}`)),
    brands: requests.brandLimit > 0 ? fixtureBrands(requests.brandLimit) : [],
    promotions: requests.promotionIds.map((id) => ({ id, endsAt: "2026-12-31T18:00:00.000Z" })),
    categories: requests.categoryIds.map(homeCategory),
    collections: requests.collectionIds.map((id, index) => fixtureCollection(id, index % 2 === 0 ? "carousel" : "grid")),
    homeProduct: null,
    metaobjects,
    ...(entry.scenario.apps === undefined ? {} : {
      apps: entry.scenario.apps
        ? (requests.apps ?? []).map((app) => ({
            sectionId: app.sectionId,
            html: `<div class="mx-auto max-w-7xl px-3 py-6 text-center sm:px-6"><h2 class="text-xl font-bold">${String(app.values.heading ?? "")}</h2><p class="mt-2 text-muted-foreground">${String(app.values.text ?? "")}</p></div>`,
            head: { meta: [], jsonLd: [] },
          }))
        : [],
    }),
  };
}

function listing(entry: GalleryEntry) {
  const size = entry.scenario.listing ?? "large";
  const count = size === "empty" ? 0 : size === "small" ? 5 : 24;
  const total = size === "large" ? 1240 : count;
  return {
    products: cardProducts(count, 0, { bangla: entry.scenario.locale === "bn" }),
    pagination: { page: 1, limit: 24, total, totalPages: Math.max(1, Math.ceil(total / 24)) },
    priceRange: { min: 250, max: 98500 },
    facets: size === "large" ? fixtureFacets() : [],
    ratingFacet: [{ min: 4, count: 820 }, { min: 3, count: 1010 }, { min: 2, count: 1100 }, { min: 1, count: 1140 }],
  };
}

function productApps(entry: GalleryEntry) {
  if (!entry.scenario.apps) return { blocks: [] };
  return {
    blocks: [
      {
        id: "wishlist",
        app: "acme.wishlist/button",
        placement: "buy-box",
        html: '<form class="mt-3" action="/apps/acme.wishlist/toggle" method="post" data-app-form><input type="hidden" name="productId" value="prod_0"><button type="submit" class="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground" aria-pressed="false"><span aria-hidden="true">&#9825;</span><span data-app-label>Save to wishlist</span></button><p class="mt-1 text-sm text-muted-foreground" role="status" data-app-message></p></form>',
        head: { meta: [], jsonLd: [] },
      },
      { id: "note", app: "acme.hello/note", placement: "below", html: '<p class="text-sm text-muted-foreground">Packed with care in Dhaka.</p>', head: { meta: [], jsonLd: [] } },
    ],
  };
}

/** The blocks apps draw at the checkout targets (sanitized HTML: content and links, no forms or scripts). */
function checkoutApps(entry: GalleryEntry) {
  if (!entry.scenario.checkoutBlocks) return { blocks: [] };
  const head = { meta: [], jsonLd: [] };
  return {
    blocks: [
      {
        id: "acme.delivery/promise",
        app: "acme.delivery/promise",
        target: "purchase.checkout.contact.render-after",
        html: '<div class="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground"><p><strong>Delivery promise.</strong> Order before 12 pm and it arrives today inside Dhaka, or tomorrow everywhere else.</p><p class="mt-1"><a class="font-medium underline underline-offset-4" href="/pages/delivery">See delivery times by district</a></p></div>',
        head,
      },
      {
        id: "acme.trust/returns",
        app: "acme.trust/returns",
        target: "purchase.checkout.shipping-option-list.render-after",
        html: '<ul class="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"><li><strong>7-day returns.</strong> Free pickup from your door in Dhaka.</li><li><strong>Official warranty</strong> on every phone and laptop.</li><li><strong>Cash on delivery</strong> checked before you pay.</li></ul>',
        head,
      },
      {
        id: "acme.loyalty/points",
        app: "acme.loyalty/points",
        target: "purchase.checkout.cart-line-list.render-after",
        html: '<p class="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">You will earn <strong>120 Nakshi points</strong> with this order. <a class="underline underline-offset-4" href="/account/rewards">View your rewards</a></p>',
        head,
      },
    ],
  };
}

/** Recorded reads nothing answered (gallery index "missing reads"). */
export const unansweredReads = new Map<string, Set<string>>();

function answer(entry: GalleryEntry, path: string, search: URLSearchParams): unknown {
  const theme = entryTheme(entry);
  if (path === "/api/v1/storefront/layout") return layout(entry);
  if (path === "/api/v1/storefront/homepage") {
    return { seo: { homepageTitle: null, homepageMetaDescription: null }, sections: sectionData(entry, theme.pages.home) };
  }
  const landing = /^\/api\/v1\/storefront\/landing\/([^/]+)$/.exec(path);
  if (landing) return { sections: sectionData(entry, theme.pages.landing[decodeURIComponent(landing[1]!)]?.sections ?? []) };
  const template = /^\/api\/v1\/storefront\/template\/([^/]+)$/.exec(path);
  if (template) {
    const kind = template[1] as keyof StorefrontThemeDocument["pages"]["templates"];
    return { sections: sectionData(entry, theme.pages.templates[kind]?.sections ?? []) };
  }
  if (path === "/api/v1/shipping-methods") return { shippingMethods: fixtureShippingMethods() };
  if (path === "/api/v1/checkout/config") return { gateways: [{ id: "cod", name: "Cash on delivery", countries: ["BD"] }] };
  const checkoutApp = /^\/api\/v1\/storefront\/app-blocks\/(checkout)$/.exec(path);
  if (checkoutApp) return checkoutApps(entry);
  const productApp = /^\/api\/v1\/storefront\/product-apps\/([^/]+)$/.exec(path);
  if (productApp) return productApps(entry);
  const product = /^\/api\/v1\/products\/([^/]+)$/.exec(path);
  if (product) {
    const scenario = productScenarioOf(decodeURIComponent(product[1]!));
    return scenario ? productDetail(scenario) : undefined;
  }
  const category = /^\/api\/v1\/categories\/([^/]+)\/products$/.exec(path);
  if (category) {
    return { ...listing(entry), category: categoryDetail(decodeURIComponent(category[1]!)), shelfProducts: cardProducts(16, 3) };
  }
  const collection = /^\/api\/v1\/collections\/([^/]+)$/.exec(path);
  if (collection) {
    const value = fixtureCollection(decodeURIComponent(collection[1]!));
    return { ...value, ...listing(entry), collection: value, categories: value.categories };
  }
  const brand = /^\/api\/v1\/brands\/([^/]+)(?:\/products)?$/.exec(path);
  if (brand) {
    const record = fixtureBrands(24).find((each) => each.slug === decodeURIComponent(brand[1]!)) ?? fixtureBrands(1)[0]!;
    return {
      ...listing(entry),
      brand: { ...record, description: "Official partner since 2019. Every device carries the brand warranty.", metaTitle: null, metaDescription: null, noIndex: false, excludeFromSitemap: false, listingTemplate: null, createdAt: null, updatedAt: null },
    };
  }
  if (path === "/api/v1/products") return search.get("q") === "zzz-nothing" || entry.scenario.listing === "empty" ? { ...listing({ ...entry, scenario: { ...entry.scenario, listing: "empty" } }) } : listing(entry);
  if (path === "/api/v1/products/search/suggestions" || path === "/api/v1/search/suggestions") return { suggestions: [], categories: [] };
  const page = /^\/api\/v1\/(?:storefront\/)?pages\/(?:slug\/)?([^/]+)$/.exec(path);
  if (page) return { page: fixturePage(decodeURIComponent(page[1]!), entry.scenario.locale === "bn") };
  if (path === "/api/v1/locations/cities") return [{ id: "dhaka", name: "Dhaka" }, { id: "chattogram", name: "Chattogram" }, { id: "sylhet", name: "Sylhet" }];
  if (path === "/api/v1/checkout-languages/active") return { language: null };
  if (path === "/api/v1/navigation/categories") return fixtureCategoryTree();
  if (path === "/api/v1/navigation") return fixtureMenu();
  const rules = /^\/api\/v1\/address-rules\/([A-Z]{2})$/.exec(path);
  if (rules) {
    return {
      countryCode: rules[1], format: "%N%n%O%n%A%n%D%n%C %Z", rows: [["name"], ["line1"], ["line2"], ["dependentLocality"], ["locality", "postalCode"]],
      allowedFields: ["name", "line1", "line2", "dependentLocality", "locality", "postalCode"], requiredFields: ["name", "line1", "locality"], upperFields: [],
      postalCodePattern: "\\d{4}", postalCodeExamples: ["1000", "1205"],
      labels: { adminArea: "district", locality: "city", dependentLocality: "suburb", postalCode: "postal" }, adminAreas: [],
    };
  }
  if (path === "/api/v1/categories") return { categories: fixtureCategoryTree().nodes.slice(0, 18).map((node) => ({ ...node, description: null, metaTitle: null, metaDescription: null, createdAt: null })) };
  return undefined;
}

function record(entry: GalleryEntry, path: string) {
  const reads = unansweredReads.get(entry.id) ?? new Set<string>();
  reads.add(path);
  unansweredReads.set(entry.id, reads);
}

/** The cart check for a seeded cart: every line is priced as sent and in stock, except the fixture's sold-out products. */
async function cartValidation(request: Request) {
  const body = (await request.clone().json().catch(() => null)) as { items?: Array<{ cartKey?: string | null; productId: string; variantId: string; quantity: number; price: number; productName?: string | null; variantLabel?: string | null }> } | null;
  const items = body?.items ?? [];
  const issues = items.flatMap((item, index) => fixtureProductSoldOut(item.productId)
    ? [{ index, cartKey: item.cartKey ?? null, productId: item.productId, variantId: item.variantId, code: "OUT_OF_STOCK", message: `${item.productName ?? "This item"} is sold out.`, requestedQuantity: item.quantity, availableQuantity: 0 }]
    : []);
  return {
    valid: issues.length === 0,
    issues,
    items: items.map((item, index) => ({
      index, cartKey: item.cartKey ?? null, productId: item.productId, variantId: item.variantId, quantity: item.quantity,
      unitPrice: item.price, productName: item.productName ?? "", variantLabel: item.variantLabel ?? null, freeDelivery: false,
      availableQuantity: fixtureProductSoldOut(item.productId) ? 0 : 12, productImageMediaId: null, productImage: null, fulfillmentKind: "physical", fulfillmentType: null,
    })),
    subtotal: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    hasFreeDeliveryProduct: false,
    requiresDeliveryMethod: true,
    requiresShipping: true,
    allowedPaymentMethods: ["cod"],
  };
}

/** Answers one request the storefront sent to the fixture API origin. */
export async function answerFixtureApi(entry: GalleryEntry, request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = apiPath(url.pathname);
  const json = { "Content-Type": "application/json" };
  if (url.pathname === "/api/v1/orders/cart-validation" && request.method === "POST") {
    return new Response(envelope(await cartValidation(request)), { headers: json });
  }
  if (url.pathname === "/api/v1/auth/token") {
    return new Response(envelope({ token: "gallery-token", expiresIn: 3600 }), { headers: json });
  }
  if (url.pathname === "/api/v1/storefront/batch") {
    const parts = url.searchParams.getAll("r").map((part) => {
      const partUrl = new URL(part, url.origin);
      partUrl.pathname = apiPath(partUrl.pathname);
      const data = answer(entry, partUrl.pathname, partUrl.searchParams);
      if (data === undefined) {
        record(entry, partUrl.pathname);
        return { status: 404, body: "{}", contentType: "application/json" };
      }
      return { status: 200, body: envelope(data), contentType: "application/json" };
    });
    return new Response(envelope({ parts }), { headers: json });
  }
  const posted = await browserPostAnswer(entry, url.pathname, request);
  if (posted !== null) return new Response(envelope(posted), { headers: json });
  const data = answer(entry, url.pathname, url.searchParams);
  if (data === undefined) {
    record(entry, `${request.method} ${url.pathname}`);
    return new Response(JSON.stringify({ success: false, error: { code: "not_found", message: "Not in the gallery fixtures" } }), { status: 404, headers: json });
  }
  return new Response(envelope(data), { headers: json });
}
