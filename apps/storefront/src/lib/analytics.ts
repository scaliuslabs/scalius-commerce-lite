// The store's own tags as listeners of the buyer event bus
// (lib/buyer-events/bus.ts, packages/shared/src/plugins/buyer-events.ts): the
// Meta Pixel and its Conversions API relay, the TikTok Pixel, GA4/GTM's
// dataLayer and Cloudflare Zaraz's e-commerce API hear the same events app
// pixels and islands do. The bus loads this module when the page has one of
// those destinations, and it hears the page's events from the start.
//
// A destination gets ids, quantities, unit prices, titles, the category,
// currency and totals: never a line's buyer inputs (Wave A P6), a contact, a
// payment method or tender detail. A Meta or TikTok event and its server relay
// carry one id (`<Event>:<bus event id>`; a purchase is `Purchase:<order id>`,
// and its Conversions API event comes from the server outbox).

import { getCurrencyCode, getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import type { AnyBuyerEvent, BuyerLine, BuyerMerchandise, BuyerMoney } from "@scalius/shared/plugins/buyer-events";
import { onBuyerEvents } from "./buyer-events/bus";
import { claimOnce } from "./buyer-events/once";
import type { MetaCapiEventPayload } from "./api/tracking";
import { sendServerEvent } from "./tracking/meta-capi";
import { marketingAllowed } from "./tracking/consent";
import { createMetaEventId } from "./tracking/meta-event-id";
import { createPurchaseEventId } from "./tracking/meta-purchase-guard";

// Window augmentation for dataLayer, fbq, ttq and Zaraz is in src/env.d.ts.

type Item = { id: string; quantity: number; price?: number; name?: string };

/** One event in the destinations' common terms (decimal amounts, as their APIs take them). */
interface Commerce {
  items: Item[];
  currency: string;
  value?: number;
  name?: string;
  category?: string;
  orderId?: string;
  query?: string;
  /** A list (category, collection, an order): Meta's `product_group`. */
  group?: boolean;
  /** Ids other than the items' (a product page names the product). */
  contentIds?: string[];
}

type Params = Record<string, unknown>;

/** Without `undefined` values, recursively (destinations read a missing key, not `undefined`). */
function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, clean(item)])) as T;
  }
  return value;
}

const major = (money: BuyerMoney | null | undefined): number | undefined =>
  money ? fromMinor(money.amountMinor, getDecimalPlaces(money.currency)) : undefined;

function itemOf(merchandise: BuyerMerchandise, quantity = 1): Item {
  return { id: merchandise.variantId ?? merchandise.productId, quantity, price: major(merchandise.price), name: merchandise.title || undefined };
}

function sum(items: Item[]): number | undefined {
  const priced = items.filter((item) => item.price !== undefined);
  return priced.length > 0 ? priced.reduce((total, item) => total + item.price! * item.quantity, 0) : undefined;
}

function ofLines(lines: BuyerLine[], total: BuyerMoney | null, extra: Partial<Commerce> = {}): Commerce {
  const items = lines.map((line) => itemOf(line.merchandise, line.quantity));
  const currency = total?.currency ?? lines.find((line) => line.merchandise.price)?.merchandise.price?.currency ?? getCurrencyCode();
  return { items, currency, value: major(total) ?? sum(items), ...extra };
}

const quantityOf = (c: Commerce) => c.items.reduce((total, item) => total + item.quantity, 0);
const idsOf = (c: Commerce) => c.contentIds ?? c.items.map((item) => item.id);

/** Meta Pixel (`eventID`) and its server relay under one id; `relay: false` when the server outbox sends it. */
function meta(name: MetaCapiEventPayload["eventName"], c: Commerce, eventId: string, relay = true): void {
  const data = clean({
    content_ids: idsOf(c),
    content_type: c.group ? "product_group" as const : "product" as const,
    contents: c.items.map((item) => ({ id: item.id, quantity: item.quantity, item_price: item.price })),
    content_name: c.name,
    content_category: c.category,
    currency: c.currency,
    value: c.value,
    num_items: name === "InitiateCheckout" || name === "Purchase" ? quantityOf(c) : undefined,
    order_id: c.orderId,
    search_string: c.query,
  });
  if (marketingAllowed() && typeof window.fbq === "function") window.fbq("track", name, data, { eventID: eventId });
  if (relay) sendServerEvent({ eventId, eventName: name, customData: data });
}

/** TikTok's standard events; only a configured pixel hears them (an unrelated `ttq` global never does). */
function tiktok(name: string, c: Commerce | null, eventId: string): void {
  const track = window.ttq?.track;
  if (window.__TIKTOK_PIXEL_ENABLED__ !== true || !marketingAllowed() || typeof track !== "function") return;
  const params = c
    ? {
      event_id: eventId,
      content_type: "product",
      content_ids: idsOf(c),
      contents: c.items.map((item) => ({ content_id: item.id, quantity: item.quantity })),
      quantity: quantityOf(c),
      currency: c.currency,
      value: c.value,
      search_string: c.query,
    }
    : { event_id: eventId };
  try {
    track.call(window.ttq, name, clean(params));
  } catch (error) {
    console.warn("TikTok Pixel event failed:", error);
  }
}

/** GA4/GTM: an e-commerce event (the previous `ecommerce` cleared first), or a plain one. */
function ga4(name: string, c: Commerce | null, eventId: string, params: Params = {}): void {
  window.dataLayer = window.dataLayer || [];
  if (!c) {
    window.dataLayer.push(clean({ event: name, event_id: eventId, ...params }));
    return;
  }
  const items = c.items.map((item, index) => ({
    item_id: item.id,
    item_name: c.items.length === 1 && !c.orderId ? item.name ?? c.name : undefined,
    item_category: c.category,
    price: item.price,
    quantity: item.quantity,
    index,
  }));
  window.dataLayer.push({ ecommerce: null });
  window.dataLayer.push(clean({
    event: name,
    event_id: eventId,
    ecommerce: { currency: c.currency, value: c.value, items, transaction_id: c.orderId, ...params, event_id: eventId },
  }));
}

/** Cloudflare Zaraz's e-commerce API, when Zaraz is on the zone. */
function zaraz(name: string, c: Commerce, params: Params = {}): void {
  const ecommerce = window.zaraz?.ecommerce;
  if (typeof ecommerce !== "function") return;
  const products = c.items.map((item, index) => ({ product_id: item.id, sku: item.id, quantity: item.quantity, price: item.price, position: index + 1 }));
  try {
    void Promise.resolve(ecommerce(name, clean({ products, currency: c.currency, value: c.value, ...params }))).catch((error: unknown) => {
      console.warn("Zaraz ecommerce event failed:", error);
    });
  } catch (error) {
    console.warn("Zaraz ecommerce event failed:", error);
  }
}

/** One bus event to every destination that has a counterpart. */
function hear(event: AnyBuyerEvent): void {
  const id = (name: string) => createMetaEventId(name, event.id);
  switch (event.name) {
    case "product_viewed": {
      const { merchandise, category } = event.data;
      const item = itemOf(merchandise);
      const c: Commerce = { items: [item], contentIds: [merchandise.productId], currency: merchandise.price?.currency ?? getCurrencyCode(), value: item.price, name: merchandise.title || undefined, category: category ?? undefined };
      meta("ViewContent", c, id("ViewContent"));
      tiktok("ViewContent", c, id("ViewContent"));
      zaraz("Product Viewed", c, { product_id: item.id, sku: item.id, name: c.name, category: c.category, price: item.price, quantity: 1, products: undefined });
      ga4("view_item", c, id("ViewContent"));
      return;
    }
    case "collection_viewed": {
      const { collection, products } = event.data;
      const c = ofLines(products.map((merchandise) => ({ merchandise, quantity: 1 })), null, { group: true, name: collection.title, category: collection.title });
      meta("ViewContent", c, id("ViewContent"));
      zaraz("Product List Viewed", c, { list_id: collection.id ?? undefined, category: collection.title });
      ga4("view_item_list", { ...c, value: undefined }, id("ViewContent"), { item_list_id: collection.id ?? undefined, item_list_name: collection.title });
      return;
    }
    case "search_submitted": {
      const c = ofLines(event.data.results.map((merchandise) => ({ merchandise, quantity: 1 })), null, { query: event.data.query });
      meta("Search", c, id("Search"));
      tiktok("Search", c, id("Search"));
      zaraz("Products Searched", c, { query: event.data.query });
      ga4("search", null, id("Search"), { search_term: event.data.query, currency: c.currency, value: c.value });
      return;
    }
    case "product_added_to_cart": {
      const c = ofLines([event.data.line], null, { name: event.data.line.merchandise.title || undefined });
      const [item] = c.items;
      meta("AddToCart", c, id("AddToCart"));
      tiktok("AddToCart", c, id("AddToCart"));
      zaraz("Product Added", c, { product_id: item?.id, sku: item?.id, name: c.name, price: item?.price, quantity: item?.quantity });
      ga4("add_to_cart", c, id("AddToCart"));
      return;
    }
    case "product_removed_from_cart": {
      const c = ofLines([event.data.line], null);
      zaraz("Product Removed", c, { product_id: c.items[0]?.id, quantity: c.items[0]?.quantity });
      ga4("remove_from_cart", c, id("RemoveFromCart"));
      return;
    }
    case "cart_viewed": {
      const c = ofLines(event.data.lines, event.data.total);
      zaraz("Cart Viewed", c);
      ga4("view_cart", c, id("ViewCart"));
      return;
    }
    case "checkout_started": {
      const c = ofLines(event.data.checkout.lines, event.data.checkout.total);
      meta("InitiateCheckout", c, id("InitiateCheckout"));
      tiktok("InitiateCheckout", c, id("InitiateCheckout"));
      zaraz("Checkout Started", c, { total: c.value, quantity: quantityOf(c) });
      ga4("begin_checkout", c, id("InitiateCheckout"));
      return;
    }
    case "checkout_shipping_submitted": {
      const c = ofLines(event.data.checkout.lines, event.data.checkout.total);
      ga4("add_shipping_info", c, id("AddShippingInfo"), { shipping_tier: event.data.shipping.title || undefined });
      return;
    }
    case "checkout_payment_submitted": {
      // The method stays out: a gift card or tender is nobody's business but the store's.
      const c = ofLines(event.data.checkout.lines, event.data.checkout.total);
      meta("AddPaymentInfo", c, id("AddPaymentInfo"));
      tiktok("AddPaymentInfo", c, id("AddPaymentInfo"));
      zaraz("Payment Info Entered", c, { total: c.value });
      ga4("add_payment_info", c, id("AddPaymentInfo"));
      return;
    }
    case "checkout_completed": {
      const orderId = event.data.order.id;
      const c = ofLines(event.data.checkout.lines, event.data.checkout.total, { orderId, group: true, name: `Order ${orderId}` });
      const purchaseId = createPurchaseEventId(orderId);
      // The Conversions API purchase comes from the server outbox, under the same id.
      meta("Purchase", c, purchaseId, false);
      tiktok("Purchase", c, purchaseId);
      zaraz("Order Completed", c, { order_id: orderId, total: c.value, revenue: c.value, quantity: quantityOf(c) });
      ga4("purchase", c, purchaseId);
      return;
    }
    default:
      return;
  }
}

let started = false;

/** Starts the store's tags on the bus, once: the page's earlier events first. */
export function startStoreTags(): void {
  if (started) return;
  started = true;
  onBuyerEvents((event) => hear(event), { replay: true });
}

/**
 * A newsletter signup: Meta Lead (pixel and CAPI), TikTok SubmitForm and
 * GA4 generate_lead, one event id. It carries no contact data.
 */
export function trackLead(data: { source?: string } = {}): void {
  const eventId = createMetaEventId("Lead");
  const customData = data.source ? { content_name: data.source } : undefined;
  if (marketingAllowed() && typeof window.fbq === "function") window.fbq("track", "Lead", customData ?? {}, { eventID: eventId });
  tiktok("SubmitForm", null, eventId);
  ga4("generate_lead", null, eventId, data.source ? { lead_source: data.source } : {});
  sendServerEvent({ eventId, eventName: "Lead", customData });
}

/**
 * A new customer account: Meta and TikTok CompleteRegistration and GA4
 * sign_up, deduplicated by the customer id. The id reaches Meta hashed
 * (external_id), never in the clear.
 */
export function trackCompleteRegistration(data: { customerId?: string | null; method?: string } = {}): void {
  const customerId = data.customerId?.trim() || undefined;
  const eventId = createMetaEventId("CompleteRegistration", customerId);
  if (!claimOnce(eventId)) return;
  if (marketingAllowed() && typeof window.fbq === "function") window.fbq("track", "CompleteRegistration", { status: true }, { eventID: eventId });
  tiktok("CompleteRegistration", null, eventId);
  ga4("sign_up", null, eventId, { method: data.method ?? "otp" });
  sendServerEvent({ eventId, eventName: "CompleteRegistration", ...(customerId ? { userData: { external_id: [customerId] } } : {}) });
}

/** Test seam. */
export function resetStoreTagsForTest(): void {
  started = false;
}
