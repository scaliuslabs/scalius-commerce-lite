// src/lib/analytics.ts

/**
 * Utility functions for handling analytics scripts and event tracking
 * with Partytown for Facebook Pixel, TikTok Pixel, and Google Analytics 4,
 * plus a passive Cloudflare Zaraz e-commerce bridge when Zaraz is enabled on the zone.
 *
 * NOW INCLUDES SERVER-SIDE EVENT DISPATCHING FOR META CONVERSIONS API (CAPI).
 */
import { sendServerEvent } from "./tracking/meta-capi";
import { createMetaEventId } from "./tracking/meta-event-id";
import { normalizeSearchQuery } from "./search-query";

// Window augmentation for dataLayer, fbq, ttq, and Zaraz is in src/env.d.ts

// Analytics type definition (from database schema)
interface AnalyticsConfig {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  usePartytown: boolean;
  config: string; // JSON string for analytics configuration
  location: string; // 'head', 'body_start', 'body_end'
  createdAt: Date;
  updatedAt: Date;
}

const CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC =
  "https://static.cloudflareinsights.com/beacon.min.js";

// CAPI: Define a type for user data that can be passed into tracking functions.
interface CapiUserData {
  em?: string; // Email
  ph?: string; // Phone
  // Add other potential PII fields here if needed in the future
}

interface MetaEventOptions {
  eventId?: string;
  sendCapi?: boolean;
}

function pixelEventOptions(eventId: string) {
  return { eventID: eventId };
}

/**
 * Processes an analytics script configuration to add Partytown attributes.
 * This function adds the type="text/partytown" attribute to script tags
 * to ensure they run in a web worker via Partytown.
 */
export function processAnalyticsScript(script: AnalyticsConfig): string {
  if (!script.config) return "";

  if (
    !script.config.includes("<script") ||
    script.config.includes("text/partytown")
  ) {
    return script.config;
  }
  return script.config.replace(/<script/g, '<script type="text/partytown"');
}

/**
 * Determines if a script configuration should use Partytown.
 * Respects the usePartytown field from the database configuration.
 */
export function shouldUsePartytown(script: AnalyticsConfig): boolean {
  if (script.type === "cloudflare_web_analytics") {
    return false;
  }
  if (script.config.includes(CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC)) {
    return false;
  }

  if (typeof script.usePartytown === "boolean") {
    return script.usePartytown;
  }
  // Fallback to type-based decision if usePartytown is not explicitly set
  const partytownTypes = [
    "google_analytics",
    "facebook_pixel",
    "google_tag_manager",
    "tiktok_pixel",
  ];
  return partytownTypes.includes(script.type) || script.type === "custom";
}

type AnalyticsPrimitive = string | number | boolean;
type AnalyticsValue =
  | AnalyticsPrimitive
  | null
  | undefined
  | AnalyticsValue[]
  | { [key: string]: AnalyticsValue };

type ZarazParameters = Record<string, AnalyticsValue>;
type FbCommerceContent = {
  id: string;
  quantity: number;
  item_price?: number;
};

type TikTokStandardEvent =
  | "ViewContent"
  | "AddToCart"
  | "InitiateCheckout"
  | "AddPaymentInfo"
  | "Purchase"
  | "Search";

type TikTokCommerceData = {
  content_ids?: string[];
  content_type?: "product" | "product_group";
  contents?: FbCommerceContent[];
  currency?: string;
  num_items?: number;
  value?: number;
};

type TikTokParams = {
  event_id: string;
  content_type?: "product" | "product_group";
  content_ids?: string[];
  contents?: Array<{ content_id: string; quantity: number }>;
  quantity?: number;
  currency?: string;
  value?: number;
  search_string?: string;
};

type StorefrontAnalyticsProduct = {
  id: string;
  name?: string;
  price?: number;
  quantity?: number;
};

type AnalyticsDedupeWindow = Window & {
  __scaliusAnalyticsDedupe?: Set<string>;
};

const ANALYTICS_DEDUPE_STORAGE_KEY = "scalius_analytics_dedupe_v1";
const MAX_PERSISTED_DEDUPE_KEYS = 100;

function cleanAnalyticsValue(value: AnalyticsValue): AnalyticsValue {
  if (Array.isArray(value)) {
    return value
      .map(cleanAnalyticsValue)
      .filter((item) => item !== undefined) as AnalyticsValue[];
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, entryValue]) => [key, cleanAnalyticsValue(entryValue)])
      .filter(([, entryValue]) => entryValue !== undefined);
    return Object.fromEntries(entries) as { [key: string]: AnalyticsValue };
  }

  return value === undefined ? undefined : value;
}

function cleanAnalyticsParams(
  params: ZarazParameters,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params)
      .map(([key, value]) => [key, cleanAnalyticsValue(value)])
      .filter(([, value]) => value !== undefined),
  );
}

function sendZarazEcommerce(eventName: string, params: ZarazParameters): void {
  const ecommerce = window.zaraz?.ecommerce;
  if (typeof ecommerce !== "function") {
    return;
  }

  try {
    void Promise.resolve(
      ecommerce(eventName, cleanAnalyticsParams(params)),
    ).catch((error: unknown) => {
      console.warn("Zaraz ecommerce event failed:", error);
    });
  } catch (error) {
    console.warn("Zaraz ecommerce event failed:", error);
  }
}

function sendZarazTrack(eventName: string, params: ZarazParameters): void {
  const track = window.zaraz?.track;
  if (typeof track !== "function") {
    return;
  }

  try {
    void Promise.resolve(track(eventName, cleanAnalyticsParams(params))).catch(
      (error: unknown) => {
        console.warn("Zaraz event failed:", error);
      },
    );
  } catch (error) {
    console.warn("Zaraz event failed:", error);
  }
}

function mapFbContentsToZarazProducts(
  contents?: Array<{ id: string; quantity: number; item_price?: number }>,
  contentIds?: string[],
): Array<Record<string, AnalyticsValue>> | undefined {
  if (contents?.length) {
    return contents.map((item, index) => ({
      product_id: item.id,
      sku: item.id,
      quantity: item.quantity,
      price: item.item_price,
      position: index + 1,
    }));
  }

  if (contentIds?.length) {
    return contentIds.map((id, index) => ({
      product_id: id,
      sku: id,
      quantity: 1,
      position: index + 1,
    }));
  }

  return undefined;
}

function firstProduct(
  products?: Array<Record<string, AnalyticsValue>>,
): Record<string, AnalyticsValue> {
  return products?.[0] ?? {};
}

// --- Event Parameter Interfaces ---

interface ItemParameters {
  item_id?: string; // SKU or product ID
  item_name?: string;
  affiliation?: string; // Store or business name
  coupon?: string;
  currency?: string;
  discount?: number;
  index?: number; // Position in a list
  item_brand?: string;
  item_category?: string;
  item_category2?: string;
  item_category3?: string;
  item_category4?: string;
  item_category5?: string;
  item_list_id?: string; // ID of the list from which the item was selected
  item_list_name?: string; // Name of the list
  item_variant?: string;
  location_id?: string; // For physical stores
  price?: number; // Unit price
  quantity?: number;
}

type GA4ParamValue =
  | string
  | number
  | boolean
  | undefined
  | null
  | ItemParameters
  | ItemParameters[]
  | GA4ParamValue[];

type DataLayerParameters = Record<string, GA4ParamValue>;

// --- E-commerce Event Tracking ---

// Helper to ensure dataLayer exists for GA4/GTM.
function getGaDataLayer(): Record<string, unknown>[] {
  window.dataLayer = window.dataLayer || [];
  return window.dataLayer!;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function inferCommerceValue(data: {
  value?: number;
  contents?: FbCommerceContent[];
}): number | undefined {
  const explicitValue = finiteNumber(data.value);
  if (explicitValue !== undefined) {
    return explicitValue;
  }

  let total = 0;
  let hasPricedItem = false;
  for (const item of data.contents ?? []) {
    const price = finiteNumber(item.item_price);
    const quantity = finiteNumber(item.quantity) ?? 1;
    if (price === undefined) {
      continue;
    }
    total += price * quantity;
    hasPricedItem = true;
  }

  return hasPricedItem ? total : undefined;
}

function getTikTokContentIds(data: TikTokCommerceData): string[] | undefined {
  const explicitIds = data.content_ids?.filter(Boolean);
  if (explicitIds?.length) {
    return explicitIds;
  }

  const contentIds = data.contents?.map((item) => item.id).filter(Boolean);
  return contentIds?.length ? contentIds : undefined;
}

function mapFbContentsToTikTokContents(
  data: TikTokCommerceData,
): Array<{ content_id: string; quantity: number }> | undefined {
  const fromContents =
    data.contents
      ?.map((item) => ({
        content_id: item.id,
        quantity: finiteNumber(item.quantity) ?? 1,
      }))
      .filter((item) => Boolean(item.content_id)) ?? [];

  if (fromContents.length > 0) {
    return fromContents;
  }

  return data.content_ids?.filter(Boolean).map((id) => ({
    content_id: id,
    quantity: 1,
  }));
}

function inferTikTokQuantity(data: TikTokCommerceData): number | undefined {
  const explicitQuantity = finiteNumber(data.num_items);
  if (explicitQuantity !== undefined) {
    return explicitQuantity;
  }

  const contents = mapFbContentsToTikTokContents(data);
  if (contents?.length) {
    return contents.reduce((sum, item) => sum + item.quantity, 0);
  }

  return undefined;
}

function normalizeGa4Items(
  data: {
    content_ids?: string[];
    content_name?: string;
    content_category?: string;
    contents?: FbCommerceContent[];
  },
  options: { includeContentName?: boolean } = {},
): ItemParameters[] {
  const includeContentName = options.includeContentName !== false;
  const fromContents =
    data.contents
      ?.map((item, index) => ({
        item_id: item.id,
        item_name:
          includeContentName && data.contents?.length === 1
            ? data.content_name
            : undefined,
        item_category: data.content_category,
        price: finiteNumber(item.item_price),
        quantity: finiteNumber(item.quantity),
        index,
      }))
      .filter((item) => Boolean(item.item_id)) ?? [];

  if (fromContents.length > 0) {
    return fromContents;
  }

  return (
    data.content_ids?.filter(Boolean).map((id, index, ids) => ({
      item_id: id,
      item_name:
        includeContentName && ids.length === 1 ? data.content_name : undefined,
      item_category: data.content_category,
      quantity: 1,
      index,
    })) ?? []
  );
}

function cleanDataLayerParams(
  params: DataLayerParameters,
): Record<string, unknown> {
  return cleanAnalyticsParams(params as unknown as ZarazParameters);
}

function pushDataLayerEcommerceEvent(
  eventName: string,
  params: DataLayerParameters,
  eventId?: string,
): void {
  const dataLayer = getGaDataLayer();
  const ecommerce = cleanDataLayerParams(
    eventId ? { ...params, event_id: eventId } : params,
  );
  const event: Record<string, unknown> = {
    event: eventName,
    ecommerce,
  };

  if (eventId) {
    event.event_id = eventId;
  }

  dataLayer.push({ ecommerce: null });
  dataLayer.push(event);
}

function pushDataLayerEvent(
  eventName: string,
  params: DataLayerParameters,
  eventId?: string,
): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push(
    cleanDataLayerParams(
      eventId
        ? { event: eventName, event_id: eventId, ...params }
        : { event: eventName, ...params },
    ),
  );
}

function bridgeFbCommerceToDataLayer(
  eventName:
    | "view_item"
    | "add_to_cart"
    | "begin_checkout"
    | "add_payment_info"
    | "purchase",
  data: {
    content_ids?: string[];
    content_name?: string;
    content_category?: string;
    contents?: FbCommerceContent[];
    currency?: string;
    num_items?: number;
    value?: number;
    order_id?: string;
  },
  eventId: string,
): void {
  const currency = data.currency ?? window.__CURRENCY_CODE__;
  const value = inferCommerceValue(data);
  const params: DataLayerParameters = {
    currency,
    value,
    items: normalizeGa4Items(data, {
      includeContentName: eventName !== "purchase",
    }),
  };

  if (data.num_items !== undefined) {
    params.num_items = finiteNumber(data.num_items);
  }

  if (eventName === "purchase") {
    params.transaction_id = data.order_id ?? eventId;
  }

  pushDataLayerEcommerceEvent(eventName, params, eventId);
}

function trackTikTokEvent(
  eventName: TikTokStandardEvent,
  params: TikTokParams,
): void {
  const track = window.ttq?.track;
  if (typeof track !== "function") {
    return;
  }

  try {
    track.call(
      window.ttq,
      eventName,
      cleanAnalyticsParams(params as unknown as ZarazParameters),
    );
  } catch (error) {
    console.warn("TikTok Pixel event failed:", error);
  }
}

function bridgeFbCommerceToTikTok(
  eventName: Exclude<TikTokStandardEvent, "Search">,
  data: TikTokCommerceData,
  eventId: string,
): void {
  const contentIds = getTikTokContentIds(data);
  const contents = mapFbContentsToTikTokContents(data);
  const hasCatalogContent = Boolean(contentIds?.length || contents?.length);

  trackTikTokEvent(eventName, {
    event_id: eventId,
    content_type:
      data.content_type ?? (hasCatalogContent ? "product" : undefined),
    content_ids: contentIds,
    contents,
    quantity: inferTikTokQuantity(data),
    currency: data.currency ?? window.__CURRENCY_CODE__,
    value: inferCommerceValue(data),
  });
}

function bridgeFbSearchToTikTok(
  data: TikTokCommerceData & { search_string: string },
  eventId: string,
): void {
  const contentIds = getTikTokContentIds(data);
  const contents = mapFbContentsToTikTokContents(data);
  const hasCatalogContent = Boolean(contentIds?.length || contents?.length);

  trackTikTokEvent("Search", {
    event_id: eventId,
    content_type:
      data.content_type ?? (hasCatalogContent ? "product" : undefined),
    content_ids: contentIds,
    contents,
    quantity: inferTikTokQuantity(data),
    currency: data.currency ?? window.__CURRENCY_CODE__,
    value: inferCommerceValue(data),
    search_string: data.search_string,
  });
}

function getAnalyticsDedupeSet(): Set<string> {
  const browserWindow = window as AnalyticsDedupeWindow;
  browserWindow.__scaliusAnalyticsDedupe ??= new Set<string>();
  return browserWindow.__scaliusAnalyticsDedupe;
}

function readPersistedAnalyticsDedupeKeys(): Set<string> {
  try {
    const raw = window.sessionStorage?.getItem(ANALYTICS_DEDUPE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function writePersistedAnalyticsDedupeKeys(keys: Set<string>): void {
  try {
    const boundedKeys = Array.from(keys).slice(-MAX_PERSISTED_DEDUPE_KEYS);
    window.sessionStorage?.setItem(
      ANALYTICS_DEDUPE_STORAGE_KEY,
      JSON.stringify(boundedKeys),
    );
  } catch {
    // Browser storage can be blocked; the in-memory guard still protects this page.
  }
}

function claimAnalyticsEventKey(key: string): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  const memoryKeys = getAnalyticsDedupeSet();
  if (memoryKeys.has(key)) {
    return false;
  }

  const persistedKeys = readPersistedAnalyticsDedupeKeys();
  if (persistedKeys.has(key)) {
    memoryKeys.add(key);
    return false;
  }

  memoryKeys.add(key);
  persistedKeys.add(key);
  writePersistedAnalyticsDedupeKeys(persistedKeys);
  return true;
}

function normalizeStorefrontAnalyticsProducts(
  products: StorefrontAnalyticsProduct[] | undefined,
): FbCommerceContent[] {
  return (
    products
      ?.map((product) => {
        const id = product.id.trim();
        if (!id) return null;
        const quantity = finiteNumber(product.quantity) ?? 1;
        const item: FbCommerceContent = { id, quantity };
        const price = finiteNumber(product.price);
        if (price !== undefined) item.item_price = price;
        return item;
      })
      .filter((product): product is FbCommerceContent => product !== null) ??
    []
  );
}

function contentIdsFromContents(contents: FbCommerceContent[]): string[] {
  return contents.map((item) => item.id).filter(Boolean);
}

/**
 * Tracks a storefront search results page once for each normalized query.
 */
export function trackStorefrontSearchResults(data: {
  searchQuery: string;
  products?: StorefrontAnalyticsProduct[];
  currency?: string;
}): boolean {
  const searchString = normalizeSearchQuery(data.searchQuery);
  if (!searchString) {
    return false;
  }

  if (!claimAnalyticsEventKey(`Search:${searchString}`)) {
    return false;
  }

  const contents = normalizeStorefrontAnalyticsProducts(data.products);
  const contentIds = contentIdsFromContents(contents);
  trackFbSearch({
    content_ids: contentIds.length > 0 ? contentIds : undefined,
    contents: contents.length > 0 ? contents : undefined,
    currency: data.currency ?? window.__CURRENCY_CODE__ ?? "BDT",
    search_string: searchString,
    value: inferCommerceValue({ contents }),
  });

  return true;
}

/**
 * Tracks AddPaymentInfo once for each checkout attempt and selected method.
 */
export function trackStorefrontAddPaymentInfoOnce(data: {
  checkoutId?: string;
  paymentMethod: string;
  content_category?: string;
  content_ids?: string[];
  contents?: FbCommerceContent[];
  currency?: string;
  value?: number;
}): boolean {
  const paymentMethod = data.paymentMethod.trim();
  if (!paymentMethod) {
    return false;
  }

  const checkoutId = data.checkoutId?.trim() || "unknown-checkout";
  if (!claimAnalyticsEventKey(`AddPaymentInfo:${checkoutId}:${paymentMethod}`)) {
    return false;
  }

  const contentIds =
    data.content_ids?.map((id) => id.trim()).filter(Boolean) ??
    contentIdsFromContents(data.contents ?? []);
  const contents =
    data.contents
      ?.map((item) => {
        const normalizedItem: FbCommerceContent = {
          id: item.id.trim(),
          quantity: finiteNumber(item.quantity) ?? 1,
        };
        const price = finiteNumber(item.item_price);
        if (price !== undefined) normalizedItem.item_price = price;
        return normalizedItem;
      })
      .filter((item): item is FbCommerceContent => Boolean(item.id)) ?? [];

  trackFbAddPaymentInfo({
    content_category: data.content_category,
    content_ids: contentIds.length > 0 ? contentIds : undefined,
    contents: contents.length > 0 ? contents : undefined,
    currency: data.currency ?? window.__CURRENCY_CODE__ ?? "BDT",
    value: inferCommerceValue({ value: data.value, contents }),
  });

  return true;
}

// --- Facebook Pixel Event Tracking ---

/**
 * Tracks a PageView event for Facebook Pixel.
 * This is often handled by the base Pixel code, but can be called explicitly if needed,
 * for example, on Single Page Application (SPA) navigations.
 */
export function trackFbPageView(): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "PageView");
    console.debug("FB Pixel: PageView tracked");
  }

  sendZarazTrack("PageView", {
    page_location: window.location?.href,
    page_path: window.location?.pathname,
  });
}

/**
 * Tracks a ViewContent event for Facebook Pixel.
 * Typically used when a user views a product details page.
 */
export function trackFbViewContent(data: {
  content_ids?: string[];
  content_category?: string;
  content_name?: string;
  content_type?: "product" | "product_group";
  contents?: FbCommerceContent[];
  currency?: string;
  value?: number;
}): void {
  const eventId = createMetaEventId("ViewContent");

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq("track", "ViewContent", data, pixelEventOptions(eventId));
  }

  bridgeFbCommerceToTikTok("ViewContent", data, eventId);

  const products = mapFbContentsToZarazProducts(
    data.contents,
    data.content_ids,
  );
  const product = firstProduct(products);
  sendZarazEcommerce("Product Viewed", {
    product_id: product.product_id,
    sku: product.sku,
    category: data.content_category,
    name: data.content_name,
    price: product.price,
    quantity: product.quantity,
    currency: data.currency,
    value: data.value,
  });

  bridgeFbCommerceToDataLayer("view_item", data, eventId);

  // CAPI: Server-side Event
  sendServerEvent({
    eventId,
    eventName: "ViewContent",
    customData: {
      content_ids: data.content_ids,
      content_category: data.content_category,
      content_name: data.content_name,
      content_type: data.content_type,
      contents: data.contents,
      currency: data.currency,
      value: data.value,
    },
  });
}

/**
 * Tracks an AddToCart event for Facebook Pixel.
 */
export function trackFbAddToCart(data: {
  content_ids?: string[];
  content_name?: string;
  content_type?: "product" | "product_group";
  contents?: FbCommerceContent[];
  currency?: string;
  value?: number;
}): void {
  const eventId = createMetaEventId("AddToCart");

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq("track", "AddToCart", data, pixelEventOptions(eventId));
  }

  bridgeFbCommerceToTikTok("AddToCart", data, eventId);

  const products = mapFbContentsToZarazProducts(
    data.contents,
    data.content_ids,
  );
  const product = firstProduct(products);
  sendZarazEcommerce("Product Added", {
    product_id: product.product_id,
    sku: product.sku,
    name: data.content_name,
    price: product.price,
    quantity: product.quantity,
    products,
    currency: data.currency,
    value: data.value,
  });

  bridgeFbCommerceToDataLayer("add_to_cart", data, eventId);

  // CAPI: Server-side Event
  sendServerEvent({
    eventId,
    eventName: "AddToCart",
    customData: {
      content_ids: data.content_ids,
      content_name: data.content_name,
      content_type: data.content_type,
      contents: data.contents,
      currency: data.currency,
      value: data.value,
    },
  });
}

/**
 * Tracks an InitiateCheckout event for Facebook Pixel.
 */
export function trackFbInitiateCheckout(data: {
  content_ids?: string[];
  content_category?: string;
  content_name?: string;
  contents?: FbCommerceContent[];
  currency?: string;
  num_items?: number;
  value?: number;
}): void {
  const eventId = createMetaEventId("InitiateCheckout");

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq("track", "InitiateCheckout", data, pixelEventOptions(eventId));
  }

  bridgeFbCommerceToTikTok("InitiateCheckout", data, eventId);

  sendZarazEcommerce("Checkout Started", {
    products: mapFbContentsToZarazProducts(data.contents, data.content_ids),
    category: data.content_category,
    name: data.content_name,
    currency: data.currency,
    total: data.value,
    value: data.value,
    quantity: data.num_items,
  });

  bridgeFbCommerceToDataLayer("begin_checkout", data, eventId);

  // CAPI: Server-side Event
  sendServerEvent({
    eventId,
    eventName: "InitiateCheckout",
    customData: {
      content_ids: data.content_ids,
      content_category: data.content_category,
      content_name: data.content_name,
      contents: data.contents,
      currency: data.currency,
      num_items: data.num_items,
      value: data.value,
    },
  });
}

/**
 * Tracks an AddPaymentInfo event for Facebook Pixel.
 */
export function trackFbAddPaymentInfo(data?: {
  content_category?: string;
  content_ids?: string[];
  contents?: FbCommerceContent[];
  currency?: string;
  value?: number;
}): void {
  const eventId = createMetaEventId("AddPaymentInfo");

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq(
      "track",
      "AddPaymentInfo",
      data || {},
      pixelEventOptions(eventId),
    );
  }

  bridgeFbCommerceToTikTok("AddPaymentInfo", data ?? {}, eventId);

  sendZarazEcommerce("Payment Info Entered", {
    products: mapFbContentsToZarazProducts(data?.contents, data?.content_ids),
    category: data?.content_category,
    currency: data?.currency,
    total: data?.value,
    value: data?.value,
  });

  bridgeFbCommerceToDataLayer("add_payment_info", data ?? {}, eventId);

  // CAPI: Server-side Event
  sendServerEvent({
    eventId,
    eventName: "AddPaymentInfo",
    customData: data,
  });
}

/**
 * Tracks a Purchase event for Facebook Pixel.
 * ENHANCEMENT: Accepts PII to be passed for CAPI enrichment.
 */
export function trackFbPurchase(
  data: {
    content_ids?: string[];
    content_name?: string;
    content_type?: "product" | "product_group";
    contents?: FbCommerceContent[];
    currency: string;
    num_items?: number;
    value: number;
    order_id?: string;
  },
  userData: CapiUserData, // This is crucial for matching purchase events.
  options: MetaEventOptions = {},
): void {
  const eventId =
    options.eventId ?? createMetaEventId("Purchase", data.order_id);

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq("track", "Purchase", data, pixelEventOptions(eventId));
  }

  bridgeFbCommerceToTikTok("Purchase", data, eventId);

  sendZarazEcommerce("Order Completed", {
    order_id: data.order_id,
    total: data.value,
    revenue: data.value,
    currency: data.currency,
    products: mapFbContentsToZarazProducts(data.contents, data.content_ids),
    quantity: data.num_items,
  });

  bridgeFbCommerceToDataLayer("purchase", data, eventId);

  if (options.sendCapi !== false) {
    // CAPI: Server-side Event
    sendServerEvent({
      eventId,
      eventName: "Purchase",
      userData: userData, // Pass explicit PII for the most important event.
      customData: {
        ...data,
      },
    });
  }
}

/**
 * Tracks a Lead event for Facebook Pixel.
 */
export function trackFbLead(
  data?: {
    content_category?: string;
    content_name?: string;
    currency?: string;
    value?: number;
  },
  userData?: CapiUserData,
): void {
  const eventId = createMetaEventId("Lead");

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq("track", "Lead", data || {}, pixelEventOptions(eventId));
  }

  sendZarazTrack("Lead", { ...(data ?? {}) });

  // CAPI: Server-side Event
  sendServerEvent({
    eventId,
    eventName: "Lead",
    userData: userData,
    customData: data,
  });
}

/**
 * Tracks a CompleteRegistration event for Facebook Pixel.
 */
export function trackFbCompleteRegistration(
  data?: {
    content_name?: string;
    currency?: string;
    status?: boolean | string;
    value?: number;
  },
  userData?: CapiUserData,
): void {
  const eventId = createMetaEventId("CompleteRegistration");

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq(
      "track",
      "CompleteRegistration",
      data || {},
      pixelEventOptions(eventId),
    );
  }

  sendZarazTrack("CompleteRegistration", { ...(data ?? {}) });

  // CAPI: Server-side Event
  sendServerEvent({
    eventId,
    eventName: "CompleteRegistration",
    userData: userData,
    customData: data,
  });
}

/**
 * Tracks a Search event for Facebook Pixel.
 */
export function trackFbSearch(data: {
  content_category?: string;
  content_ids?: string[];
  contents?: FbCommerceContent[];
  currency?: string;
  search_string: string;
  value?: number;
}): void {
  const eventId = createMetaEventId("Search");

  // Client-side Pixel
  if (typeof window.fbq === "function") {
    window.fbq("track", "Search", data, pixelEventOptions(eventId));
  }

  bridgeFbSearchToTikTok(data, eventId);

  sendZarazEcommerce("Products Searched", {
    query: data.search_string,
    products: mapFbContentsToZarazProducts(data.contents, data.content_ids),
    category: data.content_category,
    currency: data.currency,
    value: data.value,
  });

  pushDataLayerEvent(
    "search",
    {
      search_term: data.search_string,
      currency: data.currency,
      value: data.value,
    },
    eventId,
  );

  // CAPI: Server-side Event
  sendServerEvent({
    eventId,
    eventName: "Search",
    customData: {
      ...data,
    },
  });
}
// --- Google Analytics 4 (GA4) Event Tracking ---

/**
 * Generic GA4 event tracking function.
 * All specific GA4 event functions will use this.
 */
function trackGA4Event(
  eventName: string,
  parameters: Record<string, GA4ParamValue>,
): void {
  pushDataLayerEcommerceEvent(eventName, parameters);
}

/**
 * Tracks a view_item_list event for GA4.
 * When a user is presented with a list of items.
 */
export function trackGA4ViewItemList(data: {
  item_list_id?: string;
  item_list_name?: string;
  items: ItemParameters[];
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("view_item_list", data);
}

/**
 * Tracks a select_item event for GA4.
 * When a user selects an item from a list.
 */
export function trackGA4SelectItem(data: {
  item_list_id?: string;
  item_list_name?: string;
  items: ItemParameters[]; // Typically a single item array
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("select_item", data);
}

/**
 * Tracks a view_item event for GA4.
 * Typically used when a user views a product details page.
 */
export function trackGA4ViewItem(data: {
  currency?: string;
  value?: number; // Total value of the items viewed
  items: ItemParameters[]; // Typically a single item array
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("view_item", data);
}

/**
 * Tracks an add_to_cart event for GA4.
 */
export function trackGA4AddToCart(data: {
  currency?: string;
  value?: number; // Total value of items added
  items: ItemParameters[];
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("add_to_cart", data);
}

/**
 * Tracks a remove_from_cart event for GA4.
 */
export function trackGA4RemoveFromCart(data: {
  currency?: string;
  value?: number; // Total value of items removed
  items: ItemParameters[];
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("remove_from_cart", data);
}

/**
 * Tracks a view_cart event for GA4.
 */
export function trackGA4ViewCart(data: {
  currency?: string;
  value?: number; // Total value of the cart
  items: ItemParameters[];
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("view_cart", data);
}

/**
 * Tracks a begin_checkout event for GA4.
 */
export function trackGA4BeginCheckout(data: {
  currency?: string;
  value?: number; // Total value of items in checkout
  coupon?: string;
  items: ItemParameters[];
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("begin_checkout", data);
}

/**
 * Tracks an add_shipping_info event for GA4.
 */
export function trackGA4AddShippingInfo(data: {
  currency?: string;
  value?: number; // Often the shipping cost itself, or total value if updated
  coupon?: string;
  shipping_tier?: string;
  items: ItemParameters[]; // Items in the cart/checkout
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("add_shipping_info", data);
}

/**
 * Tracks an add_payment_info event for GA4.
 */
export function trackGA4AddPaymentInfo(data: {
  currency?: string;
  value?: number; // Total value if updated
  coupon?: string;
  payment_type?: string;
  items: ItemParameters[]; // Items in the cart/checkout
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("add_payment_info", data);
}

/**
 * Tracks a purchase event for GA4.
 */
export function trackGA4Purchase(data: {
  transaction_id: string; // Unique ID for the transaction
  affiliation?: string;
  value: number; // Total revenue from the transaction (including tax and shipping)
  tax?: number;
  shipping?: number;
  currency: string;
  coupon?: string;
  items: ItemParameters[];
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("purchase", data);
}

/**
 * Tracks a refund event for GA4.
 */
export function trackGA4Refund(data: {
  transaction_id: string; // ID of the original transaction being refunded
  affiliation?: string;
  value?: number; // Total refund amount. If refunding specific items, GA4 calculates this from items array.
  currency?: string;
  items?: ItemParameters[]; // Recommended to include item details for item-level refund reporting
  [key: string]: GA4ParamValue;
}): void {
  trackGA4Event("refund", data);
}

/**
 * Tracks a search event for GA4.
 */
export function trackGA4Search(data: {
  search_term: string;
  [key: string]: GA4ParamValue; // Allow other custom parameters like number_of_results
}): void {
  // GA4 search event does not use the 'ecommerce' object structure typically.
  // It's a direct event with parameters.
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "search",
    ...data, // Spread other parameters, including search_term
  });
}

/**
 * Tracks a generate_lead event for GA4 (Recommended Event).
 */
export function trackGA4GenerateLead(data?: {
  value?: number;
  currency?: string;
  [key: string]: GA4ParamValue;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "generate_lead",
    ...(data || {}),
  });
}

/**
 * Tracks a sign_up event for GA4 (Recommended Event).
 */
export function trackGA4SignUp(data: {
  method?: string; // e.g., "Google", "Email", "Facebook"
  [key: string]: GA4ParamValue;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "sign_up",
    method: data.method,
    ...data,
  });
}

/**
 * Tracks a login event for GA4 (Recommended Event).
 */
export function trackGA4Login(data: {
  method?: string;
  [key: string]: GA4ParamValue;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "login",
    method: data.method,
    ...data,
  });
}

// It's good practice to also offer a generic page_view for GA4 if not automatically handled by config
/**
 * Tracks a page_view event for GA4.
 * While gtag.js config usually handles initial page_view, this can be used for SPAs
 * or when needing to send additional parameters with page_view.
 */
export function trackGA4PageView(data?: {
  page_title?: string;
  page_location?: string; // Full URL
  page_path?: string; // Path part of the URL
  [key: string]: GA4ParamValue;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "page_view",
    ...(data || {}),
  });
}
