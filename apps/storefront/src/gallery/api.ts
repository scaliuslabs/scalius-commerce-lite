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
  cardProduct,
  fixtureProductIndexOf,
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
} from "./fixtures";
import { fixtureObject, objectMediaIds } from "./objects";
import { NOOR_EXTENSION, noorSectionSurfaces } from "./noor";

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

export function galleryNavigation(entry: GalleryEntry) {
  const menu = fixtureMenu();
  return entry.scenario.menu === "compact"
    ? menu.slice(0, 5).map((item) => ({ ...item, subMenu: item.subMenu?.slice(0, 3).map((group) => ({ ...group, subMenu: group.subMenu?.slice(0, 3) })) }))
    : menu;
}

export function galleryStoreShape(entry: GalleryEntry) {
  return storeShapeFromFacts({
    productCount: entry.scenario.catalogSize ?? 1240,
    skuCount: entry.scenario.catalogSize ?? 4800,
    topCategoryCount: 18,
    categoryDepth: 3,
    categoryGroups: 7,
    menu: galleryNavigation(entry),
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
    navigation: galleryNavigation(entry),
    categoryTree: fixtureCategoryTree(),
    footerMenus: fixtureFooterMenus(),
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 2, priceIncrementMinor: 100 },
    ...(markets(entry) ? { markets: markets(entry) } : {}),
    theme,
    ...(entry.scenario.noor ? { appExtensions: entry.scenario.noor === "active" ? [NOOR_EXTENSION] : [] } : {}),
    brand: { logo: theme.brand.logo ? mediaAsset(GALLERY_LOGO_ID, `${STORE_NAME} logo`) : null, footerLogo: null, favicon: null },
    storeShape: galleryStoreShape(entry),
    business: entry.scenario.locale === "bn" ? { ...business, companyName: BANGLA_STORE_NAME } : business,
    seo: { socialImage: "", returnPolicy: { enabled: true, category: "finite", returnWindowDays: 7, returnFees: "free" } },
    // The API serves the store language; a Bangla store speaks Bangla in its chrome too.
    ...(entry.scenario.locale === "bn" ? { storefrontCopy: { languageCode: "bn" } } : {}),
    timeZone: "Asia/Dhaka",
    // The Platform settings take origins: the gallery server answers `/api/v1`
    // on its own origin (by the page's Referer in the browser), so the page's
    // browser reads (the cart's delivery rates) have an API to call.
    platform: { apiUrl: fixtureOrigin(), storefrontUrl: fixtureOrigin() },
    policies: FIXTURE_POLICIES,
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

/** Finite entries never wrap or invent products after the last identity. */
function catalogProducts(entry: GalleryEntry, count: number, offset = 0) {
  const total = entry.scenario.catalogSize;
  return cardProducts(total === undefined ? count : Math.min(count, Math.max(0, total - offset)), offset, { bangla: entry.scenario.locale === "bn" });
}

function catalogCollection(entry: GalleryEntry, id: string, presentation: "grid" | "carousel" = "grid") {
  const collection = fixtureCollection(id, presentation);
  if (entry.scenario.catalogSize === undefined) return collection;
  const total = entry.scenario.catalogSize;
  return {
    ...collection,
    products: catalogProducts(entry, collection.config.maxProducts),
    pagination: { page: 1, limit: collection.config.maxProducts, total, totalPages: Math.ceil(total / collection.config.maxProducts) },
  };
}

/** The section data a list of sections reads (homepage, landing and template parts). */
function sectionData(entry: GalleryEntry, sections: readonly StorefrontSection[]) {
  const requests = homeSectionRequests(sections);
  // A type that is private or gone is missing, as the API leaves it out.
  const objects = (requests.objects ?? []).flatMap((request) => fixtureObject(request.typeId, request.limit) ?? []);
  return {
    lists: requests.lists.map((list, index) => ({
      key: list.key,
      products: catalogProducts(entry, Math.min(list.limit, HOME_PRODUCT_LIST_LIMIT), entry.scenario.catalogSize === undefined ? index * 5 : 0),
      category: list.source.kind === "category" ? { id: list.source.categoryId, name: "Sarees", slug: "sarees", canonicalPath: null } : null,
      collection: list.source.kind === "collection" ? { id: list.source.collectionId, title: "Eid edit" } : null,
    })),
    media: entry.scenario.missingSectionMedia ? [] : [...new Set([...requests.mediaIds, ...objectMediaIds(objects)])].map((id) => mediaAsset(id, `Photo: ${id.replace(/-/g, " ")}`)),
    brands: requests.brandLimit > 0 ? fixtureBrands(requests.brandLimit) : [],
    promotions: requests.promotionIds.map((id) => ({ id, endsAt: "2026-12-31T18:00:00.000Z" })),
    categories: requests.categoryIds.map(homeCategory),
    collections: requests.collectionIds.map((id, index) => catalogCollection(entry, id, index % 2 === 0 ? "carousel" : "grid")),
    homeProduct: null,
    objects,
    ...(entry.scenario.noor ? { apps: entry.scenario.noor === "active" ? noorSectionSurfaces(sections, entry.scenario.product) : [] } : {}),
  };
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function listing(entry: GalleryEntry, search: URLSearchParams) {
  const size = entry.scenario.listing ?? "large";
  const total = search.get("q") === "zzz-nothing" || size === "empty" ? 0 : entry.scenario.catalogSize ?? (size === "small" ? 5 : 1240);
  if (search.has("ids")) {
    const products = [...new Set((search.get("ids") ?? "").split(","))].flatMap((id) => {
      const match = /^prod_(\d+)$/.exec(id);
      const index = match ? Number(match[1]) : -1;
      return Number.isSafeInteger(index) && index >= 0 && index < total ? [cardProduct(index, { bangla: entry.scenario.locale === "bn" })] : [];
    }).slice(0, Math.min(60, positiveInteger(search.get("limit"), 20)));
    return { products, pagination: { page: 1, limit: products.length, total: products.length, totalPages: products.length ? 1 : 0 }, facets: [], ratingFacet: [], priceRange: { min: 0, max: 0 } };
  }
  // Match the real listing's default and maximum page sizes (product-list-query.ts).
  const page = positiveInteger(search.get("page"), 1);
  const limit = Math.min(60, positiveInteger(search.get("limit"), 20));
  const offset = (page - 1) * limit;
  const finiteProducts = entry.scenario.catalogSize === undefined ? null : catalogProducts(entry, total);
  const prices = finiteProducts?.map((product) => product.discountedPrice);
  return {
    products: catalogProducts(entry, Math.min(limit, Math.max(0, total - offset)), offset),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    priceRange: prices ? { min: prices.length ? Math.min(...prices) : 0, max: prices.length ? Math.max(...prices) : 0 } : { min: 250, max: 98500 },
    facets: finiteProducts ? [] : size === "large" ? fixtureFacets() : [],
    ratingFacet: finiteProducts
      ? [4, 3, 2, 1].map((min) => ({ min, count: finiteProducts.filter((product) => product.rating && product.rating.average >= min).length }))
      : [{ min: 4, count: 820 }, { min: 3, count: 1010 }, { min: 2, count: 1100 }, { min: 1, count: 1140 }],
  };
}

/** Buyer UI travels with the private cart answer, just as it does in production. */
function checkoutApps(entry: GalleryEntry) {
  if (!entry.scenario.checkoutBuyerUi) return [];
  return [
    {
      appId: "acme.notes", releaseId: "gallery", target: "purchase.checkout.contact.render-after",
      attributes: [{ key: "gift_note", type: "multiline", label: "Gift message", maxLength: 500 }], values: {},
      ui: { type: "field", attribute: "gift_note" },
    },
    {
      appId: "acme.loyalty", releaseId: "gallery", target: "purchase.checkout.cart-line-list.render-after", attributes: [], values: {},
      ui: { type: "banner", tone: "info", text: "You will earn 120 Nakshi points with this order." },
    },
  ];
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
  if (path === "/api/v1/checkout/config") return { gateways: entry.scenario.checkout === "no-cod" ? [] : [{ id: "cod", name: "Cash on delivery", countries: ["BD"] }] };
  if (path === "/api/v1/products/recommendations") {
    const limit = Math.min(positiveInteger(search.get("limit"), 8), 20);
    const sources = new Set((search.get("productIds") ?? "").split(",").filter(Boolean));
    const products = entry.scenario.catalogSize === undefined
      ? cardProducts(limit, 3, { bangla: entry.scenario.locale === "bn" })
      : catalogProducts(entry, entry.scenario.catalogSize).filter((product) => !sources.has(product.id)).slice(0, limit);
    return { reason: sources.size ? "also_bought" : "popular", products };
  }
  const product = /^\/api\/v1\/products\/([^/]+)$/.exec(path);
  if (product) {
    const index = fixtureProductIndexOf(decodeURIComponent(product[1]!));
    if (index === null || index >= (entry.scenario.catalogSize ?? 1240)) return undefined;
    const detail = productDetail(index, { bangla: entry.scenario.locale === "bn" });
    if (entry.scenario.productContent) {
      return { ...detail, product: { ...detail.product, contentBlocks: [
        { id: "pcb_story", type: "rich-text", version: 1, placement: "after-description", settings: { title: "Made with care", html: "<p>Each motif is woven into the fabric on a pit loom, then checked before packing.</p>" } },
        { id: "pcb_features", type: "feature-list", version: 1, placement: "after-description", settings: { heading: "Materials and care", style: "cards", items: [{ title: "Cotton-silk blend", text: "Lightweight cloth with a soft drape." }, { title: "Dry clean", text: "Protect the woven motifs with gentle professional cleaning." }] } },
        { id: "pcb_faq", type: "faq", version: 1, placement: "before-reviews", settings: { heading: "Before you choose", items: [{ question: "Is the blouse stitched?", answer: "The matching blouse piece is unstitched so your tailor can adjust the fit." }] } },
      ] satisfies import("../lib/api").ProductPageContentBlock[] } };
    }
    if (!entry.scenario.productInfo) return detail;
    const labels = entry.scenario.locale === "bn"
      ? ["মাপ ও উপাদান", "যত্নের নির্দেশনা", "ডেলিভারি ও বিনিময়", "প্যাকেজে যা থাকছে", "হাতে তৈরির বিস্তারিত"]
      : entry.scenario.locale === "ar"
        ? ["المقاسات والخامات", "تعليمات العناية", "التوصيل والاستبدال", "محتويات العبوة", "تفاصيل الحرفة"]
        : ["Size and materials", "Care instructions", "Delivery and exchanges", "What's in the package", "How it is made"];
    const panels = [
      ["sizing", "<p>Length: 5.5 metres. Width: 1.2 metres. The handwoven cotton-silk fabric may vary slightly between pieces.</p>"],
      ["care", "<p>Dry clean only. Store folded in a breathable cotton bag, away from direct sunlight.</p>"],
      ["delivery", "<p>Available delivery options and their charges are shown at checkout. Review the store's exchange policy before ordering.</p>"],
      ["package", "<p>One saree and its matching unstitched blouse piece, protected in recyclable wrapping.</p>"],
      ["craft", "<p>Woven on a pit loom in Narayanganj. Each motif is inserted by hand over several weeks.</p>"],
    ].slice(0, entry.scenario.productInfo === "dense-tabs" ? 5 : 2)
      .map(([id, content], index) => ({ id: id!, title: labels[index]!, content: content! }));
    const description = entry.scenario.productInfo === "dense-tabs" ? [
      "<p>This Jamdani saree is woven in Narayanganj using a cotton-silk blend chosen for its soft drape and subtle sheen. The weave feels light against the skin while holding enough structure to make clean pleats for a full day of wear.</p>",
      "<p>The floral motifs are inserted by hand as the cloth grows on the loom. A weaver works each small group of threads into the ground fabric instead of printing or embroidering a pattern onto a finished length, giving the design its distinctive floating appearance.</p>",
      "<p>Each piece takes several weeks to complete, with the pace depending on the density of the border and the larger motifs across the body. Small differences in spacing and texture are part of this process; the photographs show the overall design rather than an identical placement on every piece.</p>",
      "<p>The saree measures approximately 5.5 metres long and 1.2 metres wide. It includes a matching unstitched blouse piece so you can choose your own neckline, sleeve length and fit with a local tailor. Please check the sizing panel before arranging alterations.</p>",
      "<p>The bottle-green ground is paired with a restrained contrast border that can be dressed up with gold jewellery or worn with simple silver pieces. Indoor lighting and individual screens can change the appearance of the colour, so use both the close-up and full-length photographs when choosing.</p>",
      "<p>For the first wear, gently air the saree in a shaded room and let any packing folds relax. Avoid pulling at a raised motif or loose end; a tailor familiar with handwoven cloth can secure a thread without disturbing the surrounding weave.</p>",
      "<p>Dry cleaning is recommended to protect the silk content and the hand-inserted motifs. Tell your cleaner that the cloth is handwoven, and ask them to test any treatment on an inconspicuous area before applying it across the saree. Do not use bleach or a tumble dryer.</p>",
      "<p>Store the clean, dry saree in a breathable cotton bag away from direct sunlight. Refold it occasionally along different lines to avoid leaving a permanent crease, and keep heavy jewellery or sharp accessories separate so they cannot catch on the fabric.</p>",
      "<p>Before dispatch, the folded cloth is checked for visible damage and packed with its blouse piece. Delivery methods, current charges and the final payable amount are shown at checkout. Review the store's published exchange policy before removing labels or making alterations.</p>",
    ].join("") : detail.product.description;
    return { ...detail, product: { ...detail.product, description, additionalInfo: panels } };
  }
  const category = /^\/api\/v1\/categories\/([^/]+)\/products$/.exec(path);
  if (category) {
    return { ...listing(entry, search), category: categoryDetail(decodeURIComponent(category[1]!)), shelfProducts: catalogProducts(entry, 16, entry.scenario.catalogSize === undefined ? 3 : 0) };
  }
  const collection = /^\/api\/v1\/collections\/([^/]+)$/.exec(path);
  if (collection) {
    const value = catalogCollection(entry, decodeURIComponent(collection[1]!));
    const list = listing(entry, search);
    return { ...value, ...list, collection: { ...value, products: list.products, pagination: list.pagination }, categories: value.categories };
  }
  const brand = /^\/api\/v1\/brands\/([^/]+)(?:\/products)?$/.exec(path);
  if (brand) {
    const record = fixtureBrands(24).find((each) => each.slug === decodeURIComponent(brand[1]!)) ?? fixtureBrands(1)[0]!;
    return {
      ...listing(entry, search),
      brand: { ...record, description: "Official partner since 2019. Every device carries the brand warranty.", metaTitle: null, metaDescription: null, noIndex: false, excludeFromSitemap: false, listingTemplate: null, createdAt: null, updatedAt: null },
    };
  }
  if (path === "/api/v1/products") return listing(entry, search);
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
    return new Response(envelope({ ...await cartValidation(request), buyerUi: checkoutApps(entry) }), { headers: json });
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
