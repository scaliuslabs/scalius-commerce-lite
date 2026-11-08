// Buyer events (COMMERCE-HOOKS H15): what the buyer does on the storefront,
// as one sealed catalog. The storefront emits each event once, where it
// happens, on one in-page bus; three kinds of listener hear the same events:
//
// - the store's own tags (Meta Pixel and Conversions API, TikTok, GA4/GTM,
//   Zaraz), which the storefront maps from these events;
// - app islands, through `context.events` (in the page, never on the buyer's
//   own pages, where no island runs);
// - app pixels (`storefront.pixel`): the app's `storefront/pixel.js` in a
//   sandboxed frame of its own on every page, checkout and the receipt
//   included. The frame has an opaque origin: no access to the page, the
//   store's cookies or storage, or the buyer's session; it connects only to
//   the app's approved hosts. It is created only once the buyer's consent
//   allows the pixel's category, and hears the page's earlier events then.
//
// Money is integer minor units with its currency. No event carries buyer
// content (line inputs, notes, gift messages). Contact fields appear only in
// the checkout's contact and address events and reach a pixel only with the
// matching protected customer data scope (./protected-data.ts); islands never
// get them.
//
// Part of the versioned plugin API: event names and fields are only added.
// Kept free of zod: the storefront, islands and pixels bundle it.

import type { ProtectedCustomerData } from "./protected-data";

/** Every buyer event, in funnel order. */
export const BUYER_EVENT_NAMES = [
  "page_viewed",
  "product_viewed",
  "collection_viewed",
  "search_submitted",
  "product_added_to_cart",
  "product_removed_from_cart",
  "cart_viewed",
  "checkout_started",
  "checkout_contact_submitted",
  "checkout_address_submitted",
  "checkout_shipping_submitted",
  "checkout_payment_submitted",
  "checkout_completed",
] as const;
export type BuyerEventName = (typeof BUYER_EVENT_NAMES)[number];

/** An app's own event: published by its islands, heard by its own islands and pixel only. */
export const APP_EVENT_NAME = "app_event" as const;

/** What a pixel can subscribe to: a buyer event, or its app's own events. */
export const PIXEL_EVENT_NAMES = [...BUYER_EVENT_NAMES, APP_EVENT_NAME] as const;
export type PixelEventName = (typeof PIXEL_EVENT_NAMES)[number];

/** The consent category a pixel needs (the store's cookie banner): none runs, or hears anything, before it. */
export const PIXEL_CONSENT_CATEGORIES = ["analytics", "marketing"] as const;
export type PixelConsentCategory = (typeof PIXEL_CONSENT_CATEGORIES)[number];

/** Bounds every event holds to. */
export const BUYER_EVENT_LIMITS = {
  /** Lines, products or results one event lists. */
  lines: 50,
  /** Characters of a title, query or name. */
  text: 200,
  /** UTF-8 bytes of an app event's JSON payload. */
  appEventBytes: 4096,
  /** An app event's name: snake_case. */
  appEventName: /^[a-z][a-z0-9_]{0,47}$/,
  /** Events of one page the bus keeps for a listener that starts later (a pixel after consent). */
  history: 100,
} as const;

/** An amount in integer minor units of its currency. */
export interface BuyerMoney {
  amountMinor: number;
  currency: string;
}

/** A product as an event names it: what the buyer saw, never their inputs. */
export interface BuyerMerchandise {
  productId: string;
  /** The SKU; null when the event is about the product (a listing, a product page before a choice). */
  variantId: string | null;
  title: string;
  /** One unit as shown (the sale price while discounted); null when unknown. */
  price: BuyerMoney | null;
}

/** A cart or order line. */
export interface BuyerLine {
  merchandise: BuyerMerchandise;
  quantity: number;
}

/** The checkout as the buyer has it at this step. */
export interface BuyerCheckout {
  /** The store's checkout attempt id once there is one. */
  id: string | null;
  lines: BuyerLine[];
  itemCount: number;
  /** What the buyer pays, as last quoted; null before a quote. */
  total: BuyerMoney | null;
}

/** Protected: `email` and `phone` each need their scope (read_customer_emails, read_customer_phones). */
export interface BuyerContact {
  email: string | null;
  phone: string | null;
}

/**
 * The delivery address. `name` needs read_customer_names and `line1`,
 * `line2` read_customer_addresses; the region (country, admin area,
 * locality, postal code) is not protected.
 */
export interface BuyerAddress {
  name: string | null;
  line1: string | null;
  line2: string | null;
  locality: string | null;
  adminArea: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2. */
  countryCode: string | null;
}

export interface BuyerEventData {
  /** Once per page, for every page. */
  page_viewed: Record<string, never>;
  /** A product page. */
  product_viewed: { merchandise: BuyerMerchandise; category: string | null };
  /** A category, brand or collection page (its first page of products). */
  collection_viewed: {
    collection: { kind: "category" | "brand" | "collection"; id: string | null; title: string };
    products: BuyerMerchandise[];
  };
  /** A search results page, once per query in a session. */
  search_submitted: { query: string; results: BuyerMerchandise[] };
  /** Units of a line added (`quantity`: the units added, from any add: the buy form, a card, an island, buy now). */
  product_added_to_cart: { line: BuyerLine };
  /** Units of a line taken out by the buyer (`quantity`: the units removed). */
  product_removed_from_cart: { line: BuyerLine };
  /** The cart page. */
  cart_viewed: { lines: BuyerLine[]; total: BuyerMoney | null };
  /** Once per page where a checkout begins (a buyer with lines and a phone, or buy now). */
  checkout_started: { checkout: BuyerCheckout };
  /** The contact the order goes on, as the buyer submits the checkout form. */
  checkout_contact_submitted: { checkout: BuyerCheckout; contact: BuyerContact };
  /** The delivery address, as the buyer submits the checkout form (none for pickup or nothing to ship). */
  checkout_address_submitted: { checkout: BuyerCheckout; address: BuyerAddress };
  /** The delivery or pickup option chosen. */
  checkout_shipping_submitted: {
    checkout: BuyerCheckout;
    shipping: { kind: "delivery" | "pickup"; methodId: string | null; title: string; cost: BuyerMoney | null };
  };
  /** Payment submitted: once per checkout attempt and method. */
  checkout_payment_submitted: { checkout: BuyerCheckout; payment: { method: string } };
  /** The receipt, once per order. */
  checkout_completed: { checkout: BuyerCheckout; order: { id: string } };
  /** An app's own event (`context.events.publish`); `app` is the app that published it. */
  app_event: { app: string; name: string; payload: unknown };
}

/** One event as the bus carries it. `id` is unique; the store's tags derive their deduplication ids from it. */
export interface BuyerEvent<N extends PixelEventName = PixelEventName> {
  id: string;
  name: N;
  /** ISO 8601. */
  timestamp: string;
  data: BuyerEventData[N];
}

/** Any one event, narrowed by `name`. */
export type AnyBuyerEvent = { [N in PixelEventName]: BuyerEvent<N> }[PixelEventName];

/** The page an event happened on, as a pixel hears it. */
export interface BuyerEventContext {
  page: {
    /** Origin, path and campaign parameters only (`trackingPageUrl`): never another query parameter or the fragment. */
    url: string;
    path: string;
    title: string;
    /** The referring page, projected the same way; empty when none. */
    referrer: string;
  };
  /** BCP 47. */
  language: string;
  currency: string;
  /** The visitor id (`context.visitorId()`); null without analytics consent. */
  visitorId: string | null;
}

/** What a pixel's listener gets. */
export type PixelEvent<N extends PixelEventName = PixelEventName> = BuyerEvent<N> & { context: BuyerEventContext };
export type AnyPixelEvent = { [N in PixelEventName]: PixelEvent<N> }[PixelEventName];

/** The buyer's consent, as the page holds it. */
export interface BuyerConsent {
  analytics: boolean;
  marketing: boolean;
  saleOfData: boolean;
}

/** What a pixel's setup function gets (`definePixel`). */
export interface PixelApi {
  pluginId: string;
  /** The merchant's values of the settings the manifest's `storefront.pixel.settings` names. */
  settings: Readonly<Record<string, string | number | boolean | null>>;
  /** The consent the pixel runs under (it stops when its category is withdrawn). */
  consent: Readonly<BuyerConsent>;
  /** The current visitor id; null without analytics consent. */
  visitorId(): string | null;
  /** Calls `listener` for each event of `name` (`"*"`: every event the pixel subscribes to); returns the unsubscribe. */
  on<N extends PixelEventName>(name: N, listener: (event: PixelEvent<N>) => void): () => void;
  on(name: "*", listener: (event: AnyPixelEvent) => void): () => void;
}

/** A pixel module (`definePixel`): its setup runs once in its frame. */
export interface PixelModule {
  abi: 1;
  setup(api: PixelApi): void;
}

// ── Projection ────────────────────────────────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The event as one listener may see it: a copy (no listener changes what the
 * next hears) without the protected contact fields it lacks a scope for.
 * Islands get `granted` empty.
 */
export function projectBuyerEvent<E extends BuyerEvent>(event: E, granted: ReadonlySet<ProtectedCustomerData>): E {
  const copy = clone(event);
  const data = copy.data as Partial<BuyerEventData["checkout_contact_submitted"] & BuyerEventData["checkout_address_submitted"]>;
  if (data.contact) {
    if (!granted.has("email")) data.contact.email = null;
    if (!granted.has("phone")) data.contact.phone = null;
  }
  if (data.address) {
    if (!granted.has("name")) data.address.name = null;
    if (!granted.has("address")) {
      data.address.line1 = null;
      data.address.line2 = null;
    }
  }
  return copy;
}

/** Whether `name` is a buyer event name or the app event. */
export function isPixelEventName(name: unknown): name is PixelEventName {
  return typeof name === "string" && (PIXEL_EVENT_NAMES as readonly string[]).includes(name);
}

// ── Experiments ───────────────────────────────────────────────────────────

/** FNV-1a, 32 bits: fast, stable across browsers and runtimes, not secret. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A visitor's variant of an experiment: the same visitor, experiment and
 * variants always give the same answer, in the island and the pixel alike,
 * so a cached page can show a variant chosen in the browser and the pixel
 * can attribute conversions to it. `variants` lists names (equal weights) or
 * maps names to positive weights. Without a visitor id (no analytics
 * consent) every buyer gets the first variant: the control.
 */
export function experimentVariant(
  visitorId: string | null,
  experiment: string,
  variants: readonly string[] | Readonly<Record<string, number>>,
): string {
  const entries: Array<[string, number]> = Array.isArray(variants)
    ? (variants as readonly string[]).map((name) => [name, 1])
    : Object.entries(variants as Record<string, number>).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  if (entries.length === 0) throw new TypeError("An experiment needs at least one variant.");
  if (!visitorId) return entries[0]![0];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let point = (fnv1a(`${experiment}\u0000${visitorId}`) / 0x100000000) * total;
  for (const [name, weight] of entries) {
    if (point < weight) return name;
    point -= weight;
  }
  return entries[entries.length - 1]![0];
}

// ── The pixel frame ───────────────────────────────────────────────────────

/** The message the page sends its pixel frame once, transferring the port every later message uses. */
export const PIXEL_CONNECT_MESSAGE = "scalius:pixel-connect" as const;

/** Page → frame, over the port. */
export type PixelHostMessage =
  | {
    type: "init";
    pluginId: string;
    settings: Record<string, string | number | boolean | null>;
    consent: BuyerConsent;
    visitorId: string | null;
    events: PixelEventName[];
  }
  | { type: "event"; event: AnyPixelEvent };

/** `/_x/<plugin id>/<release>/pixel.html?connect=<hosts>`: an app release's pixel frame (served by the storefront, never by the app). */
export const STOREFRONT_PIXEL_FRAME = "pixel.html";
/** The pixel's file in an app release's storefront files (`src/pixel.ts`, built). */
export const STOREFRONT_PIXEL_FILE = "pixel.js";

/** One active app's pixel, as the layout read lists it (`appPixels`): what the page needs to run it, and nothing more. */
export interface StorefrontAppPixel {
  pluginId: string;
  /** The release's bundle SHA-256 (its files: `/_x/<plugin id>/<release>/`). */
  release: string;
  consent: PixelConsentCategory;
  events: PixelEventName[];
  /** The protected customer data its scopes reveal (`projectBuyerEvent`). */
  protectedData: ProtectedCustomerData[];
  /** Its approved hosts: the only ones its frame reaches. */
  connect: string[];
  settings: Record<string, string | number | boolean | null>;
}
