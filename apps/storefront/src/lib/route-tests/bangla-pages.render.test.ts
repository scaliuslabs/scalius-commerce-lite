// @vitest-environment node
// A Bangla store's key pages, rendered in-process the way buyers get them:
// every word the store itself writes comes from the catalogs (English and
// Bangla), and every number, price and count is in Bangla digits. Merchant
// data here is Bangla too, so an English word on the page is a missed string.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import { BANGLA_CHECKOUT_LANGUAGE_DATA, pickProductPageCopy } from "@scalius/shared/checkout-language";
import {
  STOREFRONT_TEMPLATE_IDS,
  storefrontTemplateTheme,
  storeShapeFromFacts,
  type StorefrontTemplateId,
} from "@scalius/shared/storefront-theme";
import { englishTexts, latinNumbers } from "./bangla-text";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; params?: Record<string, string> }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
const pages: Record<string, unknown> = {};
let runtimeModule: RuntimeModule;

const PAGE_MODULES = {
  product: "products/[slug]",
  category: "categories/[slug]",
  categories: "categories/index",
  search: "search/index",
  "search-empty": "search/index",
  // The customer account follows the store's language too (signed in: the session cookie).
  "account-orders": "account",
  "account-order": "account/orders/[id]",
  "account-profile": "account/profile",
  "account-inbox": "account/inbox/index",
  "account-thread": "account/inbox/[id]",
  "account-downloads": "account/downloads",
  "account-gift-cards": "account/gift-cards",
} as const;
type PageKind = keyof typeof PAGE_MODULES;

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
          name: "bangla-pages-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0bangla-pages-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0bangla-pages-test:") ? VIRTUAL_MODULES[id.slice("\0bangla-pages-test:".length)] : undefined,
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
  for (const [kind, path] of Object.entries(PAGE_MODULES)) {
    pages[kind] = (await server.ssrLoadModule(`/src/pages/${path}.astro`)).default;
  }
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const IMAGE = "https://cdn.shop.test/panjabi.jpg";
const PRODUCT = {
  id: "prod_1", name: "সুতির পাঞ্জাবি", slug: "panjabi", description: "<p>হাতে বোনা সুতি।</p>",
  price: 1750, discountedPrice: 1500, discountType: "flat", discountPercentage: 0, discountAmount: 250,
  imageUrl: IMAGE, imageMediaId: null, hasVariants: true, freeDelivery: false,
  availableForSale: true, priceVaries: false, categoryId: "cat_1", pageTemplate: null,
  options: [{ id: "size", name: "মাপ", position: 0, standardMapping: "size", values: [
    { id: "m", value: "মাঝারি", position: 0 }, { id: "l", value: "বড়", position: 1 },
  ] }],
  attributes: [{ name: "কাপড়", slug: "fabric", value: "সুতি", group: null, unit: null, keySpec: true }],
  features: ["বাংলাদেশে তৈরি"],
};
const VARIANTS = ["m", "l"].map((size, index) => ({
  optionCombinationKey: `size=${size}`, id: `sku_${size}`, productId: "prod_1", sku: `PJ-${size.toUpperCase()}`, price: 1750,
  stock: 5, reservedStock: 0, availabilityBand: "in_stock", trackInventory: true, lowStockThreshold: 2,
  fulfillmentKind: "physical", isDefault: false, deletedAt: null, barcode: null, barcodeType: null,
  imageId: null, imageUrl: IMAGE, imageMediaId: null, discountType: null, discountPercentage: null, discountAmount: null,
  selectedOptions: [{ optionDefinitionId: "size", optionValueId: size, name: "মাপ", value: index === 0 ? "মাঝারি" : "বড়", standardMapping: "size", position: 0, valuePosition: index }],
}));
const CATEGORY = { id: "cat_1", name: "পাঞ্জাবি", slug: "panjabi", description: "<p>প্রতিদিনের পাঞ্জাবি।</p>", imageUrl: IMAGE, children: [], ancestors: [] };
// Three pages, a facet with more values than the HTML shows and ratings: the
// listing draws its filters, chips, sort, page links and "See more".
const PAGINATION = { page: 1, limit: 20, total: 52, totalPages: 3 };
const FACETS = [
  {
    id: "option.size", name: "মাপ", slug: "option.size", kind: "option", display: "checkbox", unit: null, range: null,
    values: ["ছোট", "মাঝারি", "বড়", "অনেক বড়", "দ্বিগুণ বড়", "তিনগুণ বড়", "চারগুণ বড়", "পাঁচগুণ বড়", "ছয়গুণ বড়", "সাতগুণ বড়", "আটগুণ বড়", "নয়গুণ বড়", "দশগুণ বড়", "এগারোগুণ বড়"]
      .map((label, index) => ({ value: `s${index}`, label, count: 14 - index, swatch: null })),
  },
  {
    id: "brand", name: "ব্র্যান্ড", slug: "brand", kind: "brand", display: "checkbox", unit: null, range: null,
    values: [{ value: "nakshi", label: "নকশি", count: 30, swatch: null }, { value: "aarong", label: "আড়ং", count: 22, swatch: null }],
  },
];
const LISTING = {
  products: Array.from({ length: 20 }, (_, index) => ({ ...PRODUCT, id: `prod_${index + 1}`, slug: `panjabi-${index + 1}`, hasVariants: false })),
  pagination: PAGINATION, priceRange: { min: 500, max: 2500 }, facets: FACETS,
  ratingFacet: [{ min: 4, count: 20 }, { min: 3, count: 30 }, { min: 2, count: 40 }],
};
const EMPTY_LISTING = { ...LISTING, products: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 }, facets: [], ratingFacet: [] };
const REVIEWS = {
  summary: { average: 4, count: 1, histogram: [{ rating: 4, count: 1 }] },
  items: [{ id: "review_1", rating: 4, title: "ভালো", body: "খুব আরামদায়ক", authorName: "ক্রেতা", verifiedPurchase: true, publishedAt: "2026-09-12T08:00:00.000Z", editedAt: null, reply: null, variantLabel: null }],
  nextCursor: null,
};
const SHIPPING_METHODS = [
  { id: "dhaka", name: "ঢাকা", fee: 60, freeOver: null, sortOrder: 0, isActive: true, kind: "delivery", rateSource: "flat", countries: [{ code: "BD", entire: false }] },
  { id: "outside", name: "ঢাকার বাইরে", fee: 120, freeOver: null, sortOrder: 1, isActive: true, kind: "delivery", rateSource: "flat", countries: [{ code: "BD", entire: false }] },
];
const envelope = (data: unknown) => JSON.stringify({ success: true, data });
const THREAD_ID = "cnv_thread12345678";
const SECONDS = Date.parse("2026-09-12T08:00:00.000Z") / 1000;
const ACCOUNT_ORDER = {
  id: "ord_1", orderNumber: 1042, invoiceNumber: null, status: "shipped", statusLabel: "On its way", openSupportRequestType: "return",
  currencyCode: "BDT", totalAmount: 3560, paidAmount: 0, balanceDue: 3560, shippingCharge: 60, shippingMethodId: "dhaka",
  shippingMethodName: "ঢাকা", shippingMethodDescription: null, shippingMethodBaseAmountMinor: 6000, shippingFeeWaived: false,
  discountAmount: 0, paymentStatus: "unpaid", paymentMethod: "cod", fulfillmentStatus: "unfulfilled", requiresShipping: true,
  shippingMethodKind: "delivery", notes: null, createdAt: "2026-09-12T08:00:00.000Z",
  latestShipment: {
    id: "shp_1", providerType: "courier", providerName: "পাঠাও", status: "in_transit", rawStatus: null, trackingId: "PX12345",
    trackingUrl: null, courierName: null, statusLabel: "On its way", lastChecked: null, updatedAt: null, createdAt: "2026-09-12T08:00:00.000Z",
  },
  items: [{ productId: "prod_1", variantId: "sku_m", quantity: 2, price: 1750, productName: "সুতির পাঞ্জাবি", productSlug: "panjabi", productImage: IMAGE, variantLabel: "মাঝারি" }],
};
const CUSTOMER = { id: "cus_1", name: "রহিম উদ্দিন", email: null, phone: "01712345678" };
const ACCOUNT_ANSWERS: Record<string, unknown> = {
  "/customer-auth/account-summary": { unreadInbox: 2, reviewsToWrite: 1, reviewsWritten: 0, downloads: 1, giftCards: 1, activeWarranties: 0 },
  "/customer-auth/orders": {
    orders: [ACCOUNT_ORDER, { ...ACCOUNT_ORDER, id: "ord_2", orderNumber: 1041, status: "delivered", latestShipment: null, items: ACCOUNT_ORDER.items.concat(ACCOUNT_ORDER.items, ACCOUNT_ORDER.items, ACCOUNT_ORDER.items, ACCOUNT_ORDER.items) }],
    customer: CUSTOMER, summary: { totalOrders: 12 }, pagination: { hasMore: true, nextCursor: "c2" }, phoneVerification: null,
  },
  "/customer-auth/me": { authenticated: true, customer: CUSTOMER },
  "/customer-auth/marketing": { channels: [{ channel: "email", status: "not_subscribed", available: false }, { channel: "sms", status: "subscribed", available: true }] },
  "/customer-auth/payment-methods": { paymentMethods: [{
    id: "cpm_1", brand: "visa", last4: "4242", expiryMonth: 8, expiryYear: 2099, label: null, savedFor: "সাবস্ক্রাইব করে সাশ্রয়", createdAt: "2026-09-12T08:00:00.000Z",
  }] },
  "/customer-auth/addresses": { addresses: [{
    id: "adr_1", countryCode: "BD", line1: "বাড়ি ১২, রোড ৫", line2: null, city: "dhaka", zone: "mirpur", area: null, cityName: "ঢাকা",
    zoneName: "মিরপুর", areaName: null, dependentLocality: null, locality: null, adminArea: null, postalCode: null,
    isDefault: true, isDefaultBilling: false, name: "রহিম উদ্দিন", phone: null, company: null,
  }] },
  "/locations/cities": [{ id: "dhaka", name: "ঢাকা" }],
  "/locations/zones": [{ id: "mirpur", name: "মিরপুর" }],
  "/locations/areas": [{ id: "mirpur-1", name: "মিরপুর ১" }],
  "/customer-auth/conversations": {
    items: [
      { id: THREAD_ID, subjectType: "order", subject: null, orderNumber: "#1042", orderId: "ord_1", status: "pending", unread: 2, lastMessageAt: SECONDS },
      { id: "cnv_store123456789", subjectType: "store", subject: "ডেলিভারির সময়", orderNumber: null, orderId: null, status: "open", unread: 0, lastMessageAt: SECONDS - 86_400 },
    ],
    nextCursor: "n2", canStartStoreConversation: true,
  },
  [`/customer-auth/conversations/${THREAD_ID}`]: { conversation: {
    id: THREAD_ID, subjectType: "order", subject: null, orderNumber: "#1042", orderId: "ord_1", status: "closed", lastSeq: 4, readSeq: 1, hasMore: true,
    messages: [
      { id: "msg_1", seq: 1, from: "buyer", kind: "message", body: "আমার অর্ডার কবে আসবে?", createdAt: SECONDS, attachments: [], eventKind: null, eventData: null },
      { id: "msg_2", seq: 2, from: "system", kind: "event", body: null, createdAt: SECONDS + 60, attachments: [], eventKind: "support_request_status", eventData: { type: "return", toStatus: "under_review" } },
      { id: "msg_3", seq: 3, from: "store", kind: "message", body: "আগামীকাল পৌঁছাবে।", createdAt: SECONDS + 120, attachments: [{ id: "att_image1234", width: 100, height: 100 }], eventKind: null, eventData: null },
      { id: "msg_4", seq: 4, from: "store", kind: "message", body: "এটি দেখুন", createdAt: SECONDS + 180, attachments: [], eventKind: "product_reply", eventData: null,
        products: [{ title: "লিনেন পাঞ্জাবি", variantLabel: null, pdpUrl: "/products/linen", imageUrl: IMAGE, price: { amount: 2200, currency: "BDT" }, status: "sold_out" }] },
    ],
  } },
  "/customer-auth/downloads": { lines: [{
    orderId: "ord_1", orderNumber: 1042, orderItemId: "item_1", productName: "নকশার বই", variantLabel: null, deliveredAt: "2026-09-12T08:00:00.000Z",
    files: [
      { entitlementId: "ent_1", displayName: "নকশার ফাইল", downloadCount: 1, downloadLimit: 5, expiresAt: "2099-01-01T00:00:00.000Z", revoked: false, available: true, sizeBytes: 1_572_864 },
      { entitlementId: "ent_2", displayName: "পুরোনো নকশার ফাইল", downloadCount: 5, downloadLimit: 5, expiresAt: null, revoked: false, available: true, sizeBytes: 2048 },
    ],
    licenceKeys: [{ keyId: "key_1", last4: "7K2Q" }],
  }] },
  "/customer-auth/gift-cards": { giftCards: [{
    id: "gc_1", last4: "7K2Q", currencyCode: "BDT", initialAmount: 1000, initialAmountMinor: 100000, balance: 500, balanceMinor: 50000,
    expiresAt: null, expired: false, createdAt: "2026-09-12T08:00:00.000Z", status: "active", source: "purchase",
    transactions: [
      { id: "gct_1", kind: "issue", amount: 1000, amountMinor: 100000, balanceAfter: 1000, balanceAfterMinor: 100000, orderId: null, orderNumber: null, createdAt: "2026-09-12T08:00:00.000Z" },
      { id: "gct_2", kind: "redeem", amount: -500, amountMinor: -50000, balanceAfter: 500, balanceAfterMinor: 50000, orderId: "ord_1", orderNumber: "1042", createdAt: "2026-09-13T08:00:00.000Z" },
    ],
  }] },
  "/customer-auth/orders/ord_1/conversation": { conversation: null },
  "/checkout-languages/active": { language: { code: "bn", languageData: {} } },
};
const NO_SECTION_DATA = { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null };

async function render(kind: PageKind, template: StorefrontTemplateId) {
  const theme = storefrontTemplateTheme(template);
  const answer = (path: string) => {
    if (path === "/api/v1/storefront/layout") return {
      analytics: [], navigation: [], categoryTree: { nodes: [{ ...CATEGORY, parentId: null, canonicalPath: null }], truncated: false }, footerMenus: [], theme,
      storeShape: storeShapeFromFacts({ productCount: 12, skuCount: 24, topCategoryCount: 1, categoryDepth: 1, menu: [], hasCollections: false, hasDeliveryMethods: true, hasReviews: true, hasKeySpecs: true }),
      brand: { logo: null, footerLogo: null, favicon: null },
      business: { companyName: "নকশি ঘর", socialLinks: [] }, currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 }, policies: [],
      platform: { apiUrl: "https://api.shop.test", storefrontUrl: "https://shop.test", dashboardUrl: "https://admin.shop.test" },
      storefrontCopy: pickProductPageCopy("bn", BANGLA_CHECKOUT_LANGUAGE_DATA),
    };
    if (path === "/api/v1/products/panjabi") return {
      product: { ...PRODUCT, reviews: REVIEWS }, category: CATEGORY,
      media: [{ id: "primary_image", kind: "image", url: IMAGE, alt: "পাঞ্জাবি", isPrimary: true, sortOrder: 0 }],
      variants: VARIANTS, recommendations: { reason: "similar", products: LISTING.products.slice(0, 2) },
    };
    if (path.startsWith("/api/v1/storefront/template/")) return { sections: NO_SECTION_DATA };
    if (path === "/api/v1/shipping-methods") return { shippingMethods: SHIPPING_METHODS };
    if (path === "/api/v1/checkout/config") return { gateways: [{ id: "cod", name: "ক্যাশ অন ডেলিভারি", flow: "cod", countries: ["BD"] }] };
    if (path === "/api/v1/categories/panjabi/products") return { ...LISTING, category: CATEGORY };
    if (path === "/api/v1/navigation/categories") return { nodes: [{ ...CATEGORY, parentId: null, canonicalPath: null, depth: 0 }], truncated: false };
    if (path === "/api/v1/products") return kind === "search-empty" ? EMPTY_LISTING : LISTING;
    // An empty search suggests the store's popular products and its categories.
    if (path === "/api/v1/products/recommendations") return { reason: "popular", products: LISTING.products.slice(0, 4) };
    if (path === "/api/v1/categories") return [CATEGORY];
    const accountPath = path.replace(/^\/api\/v1/, "");
    if (accountPath in ACCOUNT_ANSWERS) return ACCOUNT_ANSWERS[accountPath];
    throw new Error(`Unexpected render read: ${path}`);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const data = url.pathname === "/api/v1/storefront/batch"
      ? { parts: url.searchParams.getAll("r").map((part) => ({ status: 200, body: envelope(answer(new URL(part, url.origin).pathname)), contentType: "application/json" })) }
      : answer(url.pathname);
    return new Response(envelope(data), { headers: { "Content-Type": "application/json" } });
  }));
  const paths: Record<PageKind, string> = {
    product: "/products/panjabi",
    // A chosen size and a price bound: the applied-filter chips show.
    category: "/categories/panjabi?option.size=s1&minPrice=600",
    categories: "/categories",
    search: "/search?q=পাঞ্জাবি",
    "search-empty": "/search?q=শাড়ি",
    // Saved notices show: a verified phone, a saved address, a sent message.
    "account-orders": "/account?phone=verified",
    "account-order": "/account/orders/ord_1",
    "account-profile": "/account/profile?saved=address",
    "account-inbox": "/account/inbox?conversation=sent",
    "account-thread": `/account/inbox/${THREAD_ID}`,
    "account-downloads": "/account/downloads?download=limit",
    "account-gift-cards": "/account/gift-cards",
  };
  const url = new URL(paths[kind], "https://shop.test");
  const request = new Request(url, { headers: { Cookie: "cs_tok=session-token" } });
  const params = { slug: "panjabi", id: kind === "account-order" ? "ord_1" : THREAD_ID };
  const response = await runtimeModule.requestRuntime.run(
    { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", STOREFRONT_URL: "https://shop.test", DASHBOARD_URL: "https://admin.shop.test", inflightReads: new Map() },
    () => container.renderToResponse(pages[kind], { request, locals: {}, params }),
  );
  const html = await response.text();
  expect(response.status, html.slice(0, 300)).toBe(200);
  const document = new Window().document as unknown as Document;
  document.write(html);
  return document;
}


describe("a Bangla store's pages speak Bangla", () => {
  it("finds English words and Latin-digit prices when a page has them", () => {
    const document = new Window().document as unknown as Document;
    document.write('<html><head><title>পণ্য</title></head><body><p>Sort by:</p><button aria-label="ছবি বড় করুন">৳1,750</button><p>১২টি পণ্য</p></body></html>');
    expect(englishTexts(document)).toEqual(['"Sort by:" (known: Sort)']);
    expect(latinNumbers(document)).toEqual(["৳1,750"]);
  });

  it.each(Object.keys(PAGE_MODULES) as PageKind[])("the %s page has no English interface words and no Latin-digit prices in any template", async (kind) => {
    const findings: Record<string, { english: string[]; latin: string[] }> = {};
    for (const template of STOREFRONT_TEMPLATE_IDS) {
      const document = await render(kind, template);
      expect(document.documentElement.getAttribute("lang")).toBe("bn");
      // The parts that carry the most words are really on the page.
      if (kind === "category") {
        expect(document.querySelector("[data-catalog-facet-more]"), template).not.toBeNull();
        expect(document.querySelector("[data-catalog-filter-apply]"), template).not.toBeNull();
        expect(document.querySelector("[data-catalog-pagination], [data-catalog-paging]"), template).not.toBeNull();
      }
      if (kind === "search-empty") expect(document.querySelector("[data-catalog-empty-state]"), template).not.toBeNull();
      if (kind === "product") expect(document.querySelector("[data-product-summary]"), template).not.toBeNull();
      if (kind.startsWith("account-")) expect(document.querySelector("[data-account-shell][data-account-state=ok]"), template).not.toBeNull();
      if (kind === "account-orders") expect(document.querySelectorAll("a[data-buy-again]"), template).toHaveLength(2);
      if (kind === "account-profile") {
        expect(document.querySelector("form[data-address-form]"), template).not.toBeNull();
        expect(document.querySelector("[data-account-payment-methods] [data-payment-method]"), template).not.toBeNull();
      }
      if (kind === "account-thread") expect(document.querySelectorAll("#conversationMessages > li"), template).not.toHaveLength(0);
      if (kind === "account-downloads") expect(document.querySelector("form[action='/account/licence-key']"), template).not.toBeNull();
      if (kind === "account-gift-cards") expect(document.querySelector("details"), template).not.toBeNull();
      const english = englishTexts(document);
      const latin = latinNumbers(document);
      if (english.length > 0 || latin.length > 0) findings[template] = { english, latin };
    }
    expect(findings).toEqual({});
  });
});
